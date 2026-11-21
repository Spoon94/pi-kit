import type { BoardStore } from "../board/store.js";
import type { BoardState, Task } from "../board/types.js";
import { claim, release } from "../jobs/claims.js";
import { readLiveness } from "../jobs/heartbeat.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { projectFinal } from "./finalize.js";

export interface AdoptDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string; dir: string;
  readOldBoard(sessionId: string): BoardState | undefined;
  notify(note: string): void;
  manual?: boolean;
}

const settled = (s: Task["status"]) => s === "completed" || s === "deleted";

export function adoptableRoots(d: AdoptDeps): string[] {
  const out: string[] = [];
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId) continue;
    if (!root.finalized || root.evidenceApplied) continue;
    if (root.sessionId === d.sessionId) continue;
    if (root.status === "running") continue;                    // F92/F104：running 永不收
    if (!d.manual) {
      const live = readLiveness(d.dir, root.sessionId ?? "", d.now, d.cfg.heartbeatStaleMs, d.cfg.hungSuspectMs);
      if (live !== "inactive") continue;                        // suspect 也跳过，人工才可绕
    }
    out.push(root.id);
  }
  return out;
}

/** 导入即重编号 + 悬空依赖对照旧快照解析（规格 §7.1.1-D）。 */
export function importTasks(oldBoard: BoardState, taskIds: number[], board: BoardState, oldSessionId: string) {
  const remap = new Map<number, number>();
  const uniq = [...new Set(taskIds)];
  let nextId = board.nextId;
  const imported: Task[] = [];
  for (const oldId of uniq) {
    const src = oldBoard.tasks.find((t) => t.id === oldId);
    if (!src) continue;
    const id = nextId++;
    remap.set(oldId, id);
    imported.push({ ...src, id, metadata: { ...(src.metadata ?? {}), adoptedFrom: { session: oldSessionId, id: oldId } } });
  }
  for (const t of imported) {
    if (!t.blockedBy?.length) continue;
    const kept: number[] = [];
    const resolved: number[] = [];
    for (const dep of t.blockedBy) {
      const mapped = remap.get(dep);
      if (mapped !== undefined) { kept.push(mapped); continue; }
      const old = oldBoard.tasks.find((x) => x.id === dep);
      if (old && settled(old.status)) { resolved.push(dep); continue; }
      kept.push(dep);                                            // 非终态：保留悬空
    }
    if (kept.length) t.blockedBy = kept; else delete t.blockedBy;
    if (resolved.length) t.metadata = { ...(t.metadata ?? {}), resolvedDeps: resolved };
  }
  return { board: { ...board, tasks: [...board.tasks, ...imported], nextId }, remap };
}

export function adoptOrphans(d: AdoptDeps) {
  const adopted: string[] = [];
  let imported = 0;
  const roots = adoptableRoots(d);
  const bySession = new Map<string, string[]>();
  for (const id of roots) {
    const root = d.jobs.get(id)!;
    const sid = root.sessionId ?? "";
    bySession.set(sid, [...(bySession.get(sid) ?? []), id]);
  }
  for (const [oldSid, ids] of bySession) {
    const oldBoard = d.readOldBoard(oldSid);
    if (!oldBoard) { d.notify(`孤儿链 ${ids.join(",")} 的旧 board 不可读，跳过`); continue; }
    const won: string[] = [];
    for (const id of ids) {
      if (!claim(d.dir, id, "adopt", d.sessionId, d.now)) continue;
      won.push(id);
    }
    if (won.length === 0) continue;
    const taskIds = won.map((id) => d.jobs.get(id)?.taskId).filter((x): x is number => typeof x === "number");
    const before = d.boards.get(d.sessionId);
    const { board, remap } = importTasks(oldBoard, taskIds, before, oldSid);
    d.boards.commit(d.sessionId, board);
    imported += remap.size;
    for (const id of won) {
      const root = d.jobs.get(id)!;
      const newTaskId = root.taskId !== undefined ? remap.get(root.taskId) ?? root.taskId : undefined;
      d.jobs.put({ ...root, sessionId: d.sessionId, taskId: newTaskId });
      projectFinal(id, d.jobs, d.boards, d.sessionId, d.now);
      release(d.dir, id, "adopt");
      adopted.push(id);
    }
    d.notify(`已从会话 ${oldSid} 接管 ${remap.size} 个任务、${won.length} 条已终结作业（repair）`);
  }
  d.jobs.save();
  return { adopted, imported };
}

/** 旧会话重开：本 board 的任务链已归属别的活跃会话 ⇒ 冻结（规格 §7.1.1-E）。 */
export function freezeMovedAway(d: AdoptDeps): number {
  const board = d.boards.get(d.sessionId);
  let n = 0;
  const tasks = board.tasks.map((t) => {
    if (t.metadata?.adoptedAway) return t;
    const moved = (t.jobs ?? []).map((id) => d.jobs.get(id)).find((j) => j && j.sessionId !== d.sessionId);
    if (!moved) return t;
    const live = readLiveness(d.dir, moved.sessionId ?? "", d.now, d.cfg.heartbeatStaleMs, d.cfg.hungSuspectMs);
    if (live === "inactive") return t;
    n++;
    return { ...t, metadata: { ...(t.metadata ?? {}), adoptedAway: { session: moved.sessionId } } };
  });
  if (n) d.boards.commit(d.sessionId, { ...board, tasks });
  return n;
}
