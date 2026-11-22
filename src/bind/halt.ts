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
  // 退避链全局取消（不依赖 d.kill 的实现）
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
      park: { reason: "用户强制中断", at: d.now, from: "in_progress" as const, by: "halt" as const } };
  });
  d.boards.commit(d.sessionId, { ...board, tasks,
    counters: { ...board.counters, halted: true, haltedAt: d.now } });
  d.notify(`已强制中断：取消 ${targets.length} 条作业链，${parked} 个任务 parked。用 /vigil-todo resume 恢复`);
  return { killed: targets.length, parked, alreadyHalted };
}

export function resume(d: HaltDeps): boolean {
  const board = d.boards.get(d.sessionId);
  if (!isHalted(board)) return false;
  const counters = { ...board.counters };
  delete counters.halted; delete counters.haltedAt;
  // 只恢复 halt 自己造成的 parked（显式标记，不按 reason 文案匹配）；
  // 回到 pending 交还 next/WIP 机制，绝不碰模型/用户真实决策的 park。
  let restored = 0;
  const tasks = board.tasks.map((t) => {
    if (t.status !== "parked" || t.park?.by !== "halt") return t;
    restored++;
    const next = { ...t, status: "pending" as const, statusSince: d.now };
    delete next.park;
    delete next.inProgressSince;
    return next;
  });
  d.boards.commit(d.sessionId, { ...board, tasks, counters });   // turnsUsed 不重置
  const maxTurns = d.maxTurns ?? DEFAULTS.maxTurns;
  if (board.counters.turnsUsed >= maxTurns) {
    d.notify(`已达轮数上限 (${board.counters.turnsUsed}/${maxTurns})：发任意消息归零后再继续`);
  } else {
    d.notify(restored > 0
      ? `已恢复自主推进（${restored} 个中断任务回到 pending）`
      : "已恢复自主推进");
  }
  return true;
}

/** halt 落盘后崩溃 ⇒ 启动补杀本会话残留 running（不留孤儿）。 */
export function reapHaltedLeftovers(d: HaltDeps): number {
  if (!isHalted(d.boards.get(d.sessionId))) return 0;
  const left = d.jobs.all().filter((j) => j.sessionId === d.sessionId && j.status === "running");
  for (const j of left) d.kill(j.rootId, "self");
  return left.length;
}
