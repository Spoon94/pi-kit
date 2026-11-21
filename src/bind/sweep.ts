import type { BoardStore } from "../board/store.js";
import { applyCleanup, markPurged, planCleanup, retentionCandidates } from "../board/cleanup.js";
import { chainTerminated } from "../jobs/chain.js";
import { claim, release } from "../jobs/claims.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import { runDir, type JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { projectFinal } from "./finalize.js";

export interface SweepDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string;
  respawn(req: SpawnRequest): { ok: boolean };
  notify(note: string): void;
  isIdle(): boolean;
}

export function sweepDefers(d: SweepDeps): number {
  const board = d.boards.get(d.sessionId);
  let released = 0;
  const tasks = board.tasks.map((t) => {
    if (!t.defer) return t;
    const root = d.jobs.get(t.defer.untilRoot);
    if (root && !chainTerminated(d.jobs, t.defer.untilRoot)) return t;
    if (!root) d.notify(`defer 目标 ${t.defer.untilRoot} 已无记录，已释放 #${t.id}（repair）`);
    released++;
    const next = { ...t }; delete next.defer; return next;
  });
  if (released > 0) d.boards.commit(d.sessionId, { ...board, tasks });
  return released;
}

export function sweepRespawns(d: SweepDeps): number {
  if (d.boards.get(d.sessionId).counters.halted) return 0;      // R20：停机后不 respawn
  let n = 0;
  for (const job of d.jobs.all()) {
    const dueBackoff = job.retryAt != null && job.retryAt <= d.now;
    const root = d.jobs.get(job.rootId);
    const hasReverifyJob = d.jobs.all().some((j) => j.rootId === job.rootId && j.staleReverifyOf != null);
    const dueReverify = root?.pendingReverify === true && !root.finalized && job.id === root.id && !hasReverifyJob;
    if (root?.pendingReverify === true && hasReverifyJob && !root.finalized && job.id === root.id) {
      d.jobs.put({ ...root, pendingReverify: false });    // 重验 job 已存在 ⇒ 标记已完成使命
    }
    if (!dueBackoff && !dueReverify) continue;
    if (!claim(runDir(job.cwd), job.rootId, "respawn", d.sessionId, d.now)) continue;
    const req: SpawnRequest = dueReverify
      ? { command: job.command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
          rootId: job.rootId, retryOf: job.id, attempt: job.attempt, staleReverifyOf: job.id }
      : { command: job.command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
          rootId: job.rootId, retryOf: job.id, attempt: job.attempt + 1 };
    const r = d.respawn(req);
    if (r.ok) {
      const cur = d.jobs.get(job.id)!;
      const next = { ...cur };
      delete next.retryAt;
      if (dueReverify) next.pendingReverify = false;
      d.jobs.put(next);
      n++;
    } else if (dueBackoff) {
      // spawn_error：不重试、清退避、绑定任务 parked（F32）
      const cur = d.jobs.get(job.id)!;
      const next = { ...cur };
      delete next.retryAt;
      d.jobs.put(next);
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "spawn failed");
    } else if (dueReverify) {
      const cur = d.jobs.get(job.id)!;
      d.jobs.put({ ...cur, pendingReverify: false });     // 额度尽/无槽 ⇒ 不悬置
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "无空闲槽位重验");
    }
    release(runDir(job.cwd), job.rootId, "respawn");
  }
  d.jobs.save();
  return n;
}

/** root 粒度扫描集（规格 §5.3）。 */
export function catchUpScan(d: SweepDeps): string[] {
  if (d.boards.get(d.sessionId).counters.halted) return [];      // R20：停机后不补发
  const out: string[] = [];
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId) continue;                 // 只看 root
    if (root.sessionId !== d.sessionId) continue;
    if (root.purged) continue;                             // R19：清掉的链不再补发
    if (!root.finalized) continue;
    if (!root.evidenceApplied) { out.push(root.id); continue; }
    if (root.notifyState === "acked") continue;
    if (root.notifyState === "pending") { out.push(root.id); continue; }
    const sentAt = root.notifySentAt;
    const overdue = sentAt == null || sentAt <= 0 || d.now - sentAt > d.cfg.notifyRetryMs;
    if (overdue && d.isIdle()) out.push(root.id);
  }
  return out;
}

export function sweepAll(d: SweepDeps) {
  for (const id of catchUpScan(d)) projectFinal(id, d.jobs, d.boards, d.sessionId, d.now);
  const result = { defersReleased: sweepDefers(d), respawned: sweepRespawns(d), catchUp: catchUpScan(d) };
  applyRetention(d);
  return result;
}

/** 无 job 记录的终结路径：失败后直接把绑定任务 parked。 */
function parkTask(d: SweepDeps, taskId: number | undefined, reason: string): void {
  if (taskId === undefined) return;
  const board = d.boards.get(d.sessionId);
  const idx = board.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return;
  const task = board.tasks[idx];
  if (task.status !== "in_progress") return;
  const tasks = [...board.tasks];
  tasks[idx] = {
    ...task, status: "parked", statusSince: d.now,
    park: { reason, at: d.now, from: "in_progress" },
  };
  d.boards.commit(d.sessionId, { ...board, tasks });
}

/** taskRetentionMs > 0 时清 completed/deleted，走与手动 settled 相同路径（§16.7.5）。 */
function applyRetention(d: SweepDeps): void {
  if (!d.cfg.taskRetentionMs || d.cfg.taskRetentionMs <= 0) return;
  const board = d.boards.get(d.sessionId);
  const candidates = retentionCandidates(board, d.cfg.taskRetentionMs, d.now);
  if (!candidates.length) return;
  const facts = {
    hasRunning: (taskId: number) => d.jobs.all().some((j) => j.taskId === taskId && j.status === "running"),
    hasBackoff: (taskId: number) => d.jobs.all().some((j) => j.taskId === taskId && j.retryAt != null),
    startedAt: () => undefined,
    exists: () => true,
  };
  const subset = { ...board, tasks: board.tasks.filter((t) => candidates.includes(t.id)) };
  const plan = planCleanup(subset, "settled", undefined, facts);
  if (!plan.remove.length) return;
  markPurged(d.jobs, plan.remove, board.tasks);
  d.boards.commit(d.sessionId, applyCleanup(board, plan, d.now));
}
