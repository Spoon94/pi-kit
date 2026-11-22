import type { BoardStore } from "../board/store.js";
import { applyCleanup, markPurged, planCleanup, retentionCandidates } from "../board/cleanup.js";
import { jobFactsOf } from "../jobs/facts.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { projectFinal } from "./finalize.js";

export interface SweepDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string;
  respawn(req: SpawnRequest): { ok: boolean };
  notify(note: string): void;
  isIdle(): boolean;
}

export function sweepRespawns(d: SweepDeps): number {
  if (d.boards.get(d.sessionId).counters.halted) return 0;      // R20：停机后不 respawn
  let n = 0;
  let dirty = false;
  // 重验 job 是否存在与单条 job 无关：一次扫描建集合，避免逐 job 全表扫描（P3 热点）
  const reverifyRoots = new Set<string>();
  for (const j of d.jobs.all()) if (j.staleReverifyOf != null) reverifyRoots.add(j.rootId);
  for (const job of d.jobs.all()) {
    const root = d.jobs.get(job.rootId);
    if (job.purged || root?.purged) continue;                 // R19：清掉的链不再 respawn
    const dueBackoff = job.retryAt != null && job.retryAt <= d.now;
    const hasReverifyJob = reverifyRoots.has(job.rootId);
    const dueReverify = root?.pendingReverify === true && !root.finalized && job.id === root.id && !hasReverifyJob;
    if (root?.pendingReverify === true && hasReverifyJob && !root.finalized && job.id === root.id) {
      d.jobs.put({ ...root, pendingReverify: false });    // 重验 job 已存在 ⇒ 标记已完成使命
      dirty = true;
    }
    if (!dueBackoff && !dueReverify) continue;
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
      dirty = true;
      n++;
    } else if (dueBackoff) {
      // spawn_error：不重试、清退避、绑定任务 parked（F32）
      const cur = d.jobs.get(job.id)!;
      const next = { ...cur };
      delete next.retryAt;
      d.jobs.put(next);
      dirty = true;
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "spawn failed");
    } else if (dueReverify) {
      const cur = d.jobs.get(job.id)!;
      d.jobs.put({ ...cur, pendingReverify: false });     // 额度尽/无槽 ⇒ 不悬置
      dirty = true;
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "无空闲槽位重验");
    }
  }
  if (dirty) d.jobs.save();
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
    if (root.finalResult?.trigger === "self") continue;    // R6-5：自己 park/kill 的链不叫醒自己
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
  const respawned = sweepRespawns(d);
  const catchUp = catchUpScan(d);
  const retained = applyRetention(d);
  return { respawned, catchUp, retained };
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
function applyRetention(d: SweepDeps): number {
  if (!d.cfg.taskRetentionMs || d.cfg.taskRetentionMs <= 0) return 0;
  const board = d.boards.get(d.sessionId);
  const candidates = retentionCandidates(board, d.cfg.taskRetentionMs, d.now);
  if (!candidates.length) return 0;
  const facts = jobFactsOf(d.jobs);
  const subset = { ...board, tasks: board.tasks.filter((t) => candidates.includes(t.id)) };
  const plan = planCleanup(subset, "settled", undefined, facts);
  if (!plan.remove.length) return 0;
  markPurged(d.jobs, plan.remove, board.tasks);
  d.boards.commit(d.sessionId, applyCleanup(board, plan, d.now));
  return plan.remove.length;
}
