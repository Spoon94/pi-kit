import { selectNext } from "../board/selectors.js";
import type { BoardCounters, BoardState } from "../board/types.js";
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

/** timer 存在条件：优先内部推进；只有通知时按实际可投递性过滤，避免永不可投递的 root 造成永久 timer。 */
export function needsTimer(board: BoardState, jobs: JobStore, cfg: VigilConfig): boolean {
  if (board.counters.halted) {
    // 停机时唯一还需要 timer 的理由：running 作业的退出探活（含恢复作业）
    return jobs.all().some((j) => j.status === "running");
  }
  if (jobs.all().some((j) => j.status === "running" || j.retryAt != null)) return true;
  if (board.counters.turnsUsed >= cfg.maxTurns) return false;
  return jobs.all().some((j) =>
    j.id === j.rootId && j.finalized && j.notifyState !== "acked"
    && !j.purged && j.finalResult?.trigger !== "self");
}

/** resume 后的一次性恢复唤醒：受 maxTurns 约束，只推进 next。 */
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

/** sendMessage 即使声明 void 也可能返回 Promise；吞掉 rejection，保留 sent 状态给 catch-up。 */
export function settleSend(result: unknown, onError?: (e: unknown) => void): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void (result as Promise<unknown>).then(undefined, (e) => onError?.(e));
  }
}

export function tryDeliver(i: DeliverInput): DeliverResult {
  if (i.board.counters.halted) return { kind: "none" };           // R20：人的刹车早于一切
  const c = i.board.counters;
  if (c.turnsUsed >= i.cfg.maxTurns) return { kind: "none" };      // ★ 第一行硬闸门

  const pending = i.board.tasks.flatMap((t) => t.evidence ?? [])
    .filter((e) => e.origin === "async" && e.chainFinal && e.trigger !== "self" && e.at > c.wakeWatermark)
    .filter((e) => {
      // 与 catch-up 共用 per-root 去重：已 sent/acked 的链不得再走正常通道
      if (typeof e.ref !== "string") return true;
      const root = i.jobs.get(e.ref);
      if (!root || root.id !== root.rootId) return true;
      if (root.purged) return false;
      return root.notifyState !== "sent" && root.notifyState !== "acked";
    });

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
