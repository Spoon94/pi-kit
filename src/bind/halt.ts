import type { BoardStore } from "../board/store.js";
import type { BoardState } from "../board/types.js";
import { DEFAULTS } from "../lib/config.js";
import type { JobStore } from "../jobs/store.js";

export interface HaltDeps {
  boards: BoardStore; jobs: JobStore; now: number; sessionId: string;
  kill(idOrRoot: string, by: "self" | "external"): void;
  notify(note: string): void;
  maxTurns?: number;
}

export const isHalted = (state: BoardState): boolean => state.counters.halted === true;

export function halt(d: HaltDeps) {
  const board = d.boards.get(d.sessionId);
  const alreadyHalted = isHalted(board);
  const mine = d.jobs.all().filter((j) => j.sessionId === d.sessionId);
  const targets = mine.filter((j) => j.status === "running" || j.retryAt != null);
  const affected = new Set<number>();
  for (const j of targets) {
    d.kill(j.rootId, "self");
    if (typeof j.taskId === "number") affected.add(j.taskId);
  }
  // Cancel backoff chains globally (independent of d.kill's implementation)
  for (const j of mine) {
    if (j.retryAt == null) continue;
    const cur = d.jobs.get(j.id);
    if (!cur) continue;
    const next = { ...cur };
    delete next.retryAt;
    d.jobs.put(next);
  }
  d.jobs.save();
  let parked = 0;
  const tasks = board.tasks.map((t) => {
    if (!affected.has(t.id) || t.status !== "in_progress") return t;
    parked++;
    return { ...t, status: "parked" as const, statusSince: d.now,
      park: { reason: "halted by user", at: d.now, from: "in_progress" as const, by: "halt" as const } };
  });
  d.boards.commit(d.sessionId, { ...board, tasks,
    counters: { ...board.counters, halted: true, haltedAt: d.now } });
  d.notify(`Halted: cancelled ${targets.length} job chains, ${parked} tasks parked. Use /vigil-todo resume to resume`);
  return { killed: targets.length, parked, alreadyHalted };
}

export function resume(d: HaltDeps): boolean {
  const board = d.boards.get(d.sessionId);
  if (!isHalted(board)) return false;
  const counters = { ...board.counters };
  delete counters.halted; delete counters.haltedAt;
  // Restore only parks caused by halt itself (explicit marker, not reason text);
  // back to pending and hand off to next/WIP, never touch parks from real model/user decisions.
  let restored = 0;
  const tasks = board.tasks.map((t) => {
    if (t.status !== "parked" || t.park?.by !== "halt") return t;
    restored++;
    const next = { ...t, status: "pending" as const, statusSince: d.now };
    delete next.park;
    delete next.inProgressSince;
    return next;
  });
  d.boards.commit(d.sessionId, { ...board, tasks, counters });   // turnsUsed is not reset
  const maxTurns = d.maxTurns ?? DEFAULTS.maxTurns;
  if (board.counters.turnsUsed >= maxTurns) {
    d.notify(`Turn limit reached (${board.counters.turnsUsed}/${maxTurns}): send any message to reset it, then continue`);
  } else {
    d.notify(restored > 0
      ? `Autonomous progress resumed (${restored} halted tasks back to pending)`
      : "Autonomous progress resumed");
  }
  return true;
}

/** Crash after halt is saved ⇒ on startup, kill leftover running jobs for this session (no orphans). */
export function reapHaltedLeftovers(d: HaltDeps): number {
  if (!isHalted(d.boards.get(d.sessionId))) return 0;
  const left = d.jobs.all().filter((j) => j.sessionId === d.sessionId && j.status === "running");
  for (const j of left) d.kill(j.rootId, "self");
  return left.length;
}
