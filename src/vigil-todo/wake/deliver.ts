import { selectNext } from "../board/selectors.js";
import type { BoardCounters, BoardState, Evidence } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { composeWake } from "./compose.js";

export interface DeliverInput {
  board: BoardState; jobs: JobStore; cfg: VigilConfig; now: number;
  trigger: "async" | "boundary"; modelAdvanced: boolean; capacityFull: boolean;
}
export type DeliverResult =
  | { kind: "none" }
  | { kind: "deliver"; wakeId: string; roots: string[]; text: string; counters: BoardCounters; renudge: boolean };

let wakeSeq = 0;

/** Timer condition: internal progress takes priority; for notifications only, filter by actual
 *  deliverability so never-deliverable roots do not keep a timer alive forever. */
export function needsTimer(board: BoardState, jobs: JobStore, cfg: VigilConfig): boolean {
  if (board.counters.halted) {
    // While halted, the only remaining reason to keep a timer: exit liveness checks for running jobs (including recovered jobs)
    return jobs.all().some((j) => j.status === "running");
  }
  if (jobs.all().some((j) => j.status === "running" || j.retryAt != null)) return true;
  if (board.counters.turnsUsed >= cfg.maxTurns) return false;
  const taskIds = new Set(board.tasks.map((t) => t.id));
  return jobs.all().some((j) =>
    j.id === j.rootId && j.finalized && j.notifyState !== "acked"
    && !j.purged && j.finalResult?.trigger !== "self"
    && j.taskId !== undefined && taskIds.has(j.taskId));   // dangling task: never deliverable, no timer
}

/** One-shot recovery wake after resume: constrained by maxTurns, advances next only. */
export function recoveryWake(i: DeliverInput): DeliverResult {
  if (i.board.counters.halted) return { kind: "none" };
  const c = i.board.counters;
  if (c.turnsUsed >= i.cfg.maxTurns) return { kind: "none" };
  const next = selectNext(i.board, i.cfg.wipLimit, i.capacityFull);
  if (!next) return { kind: "none" };
  return {
    kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots: [],
    text: composeWake([], i.board, i.jobs, i.cfg, next),
    counters: { ...c, turnsUsed: c.turnsUsed + 1, renudgeBudget: 1 }, renudge: false,
  };
}

/** sendMessage may return a Promise even when declared void; swallow rejection and keep sent state for catch-up. */
export function settleSend(result: unknown, onError?: (e: unknown) => void): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void (result as Promise<unknown>).then(undefined, (e) => onError?.(e));
  }
}

/** Undelivered async chain-final evidence, using the same predicate as `tryDeliver`. */
function pendingEvidence(i: Pick<DeliverInput, "board" | "jobs">, watermark: number): Evidence[] {
  return i.board.tasks.flatMap((t) => t.evidence ?? [])
    .filter((e) => e.origin === "async" && e.chainFinal && e.trigger !== "self")
    .filter((e) => {
      // per-root sidecar state is authoritative; the watermark is only an optimization and
      // must not block never-delivered chains after a clock rollback (A3)
      const withinWatermark = e.at > watermark;
      if (typeof e.ref !== "string") return withinWatermark;
      const root = i.jobs.get(e.ref);
      if (!root || root.id !== root.rootId) return withinWatermark;
      if (root.purged) return false;
      return root.notifyState !== "sent" && root.notifyState !== "acked";
    });
}

/** Distinct roots that would be delivered right now (evidence without a resolvable root counts as one block). */
export function undeliveredRoots(i: Pick<DeliverInput, "board" | "jobs">, watermark = 0): string[] {
  const pending = pendingEvidence(i, watermark);
  const roots = [...new Set(pending.map((e) => e.ref).filter((r): r is string => typeof r === "string"))];
  return roots.length > 0 ? roots : pending.length > 0 ? [""] : [];
}

/**
 * Merge-window policy: a single pending root is delivered at the end of the current turn (0 ms);
 * several roots share one message via the configured merge window so 10 exits still cost one wake.
 */
export function wakeDelayMs(pendingRootCount: number, mergeMs: number): number {
  return pendingRootCount > 1 ? Math.max(0, mergeMs) : 0;
}

export function tryDeliver(i: DeliverInput): DeliverResult {
  if (i.board.counters.halted) return { kind: "none" };           // R20: the human brake precedes everything
  const c = i.board.counters;
  if (c.turnsUsed >= i.cfg.maxTurns) return { kind: "none" };      // ★ first-line hard gate

  const pending = pendingEvidence(i, c.wakeWatermark);

  const next = selectNext(i.board, i.cfg.wipLimit, i.capacityFull);

  if (pending.length > 0) {
    const roots = [...new Set(pending.map((e) => e.ref).filter((r): r is string => typeof r === "string"))];
    const counters: BoardCounters = {
      turnsUsed: c.turnsUsed + 1,
      wakeWatermark: Math.max(...pending.map((e) => e.at)),
      renudgeBudget: 1,
    };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots,
      text: composeWake(roots, i.board, i.jobs, i.cfg, next), counters, renudge: false };
  }

  if (i.trigger === "boundary" && c.renudgeBudget > 0 && !i.modelAdvanced && next) {
    const counters: BoardCounters = { ...c, turnsUsed: c.turnsUsed + 1, renudgeBudget: c.renudgeBudget - 1 };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots: [],
      text: composeWake([], i.board, i.jobs, i.cfg, next), counters, renudge: true };
  }
  return { kind: "none" };
}
