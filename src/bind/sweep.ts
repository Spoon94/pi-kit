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
  /** Sync callback after this function modifies the board; the caller persists the snapshot (A1). */
  boardChanged?: () => void;
}

export function sweepRespawns(d: SweepDeps): number {
  if (d.boards.get(d.sessionId).counters.halted) return 0;      // R20: no respawn after halt
  let n = 0;
  let dirty = false;
  // Whether a reverify job exists is independent of any single job: build the set in one scan, avoiding a full scan per job (P3 hot spot)
  const reverifyRoots = new Set<string>();
  for (const j of d.jobs.all()) if (j.staleReverifyOf != null) reverifyRoots.add(j.rootId);
  for (const job of d.jobs.all()) {
    const root = d.jobs.get(job.rootId);
    if (job.purged || root?.purged) continue;                 // R19: purged chains are not respawned
    const dueBackoff = job.retryAt != null && job.retryAt <= d.now;
    const hasReverifyJob = reverifyRoots.has(job.rootId);
    const dueReverify = root?.pendingReverify === true && !root.finalized && job.id === root.id && !hasReverifyJob;
    if (root?.pendingReverify === true && hasReverifyJob && !root.finalized && job.id === root.id) {
      d.jobs.put({ ...root, pendingReverify: false });    // reverify job already exists ⇒ mark its mission done
      dirty = true;
    }
    if (!dueBackoff && !dueReverify) continue;
    // Reverify resume inherits the chain's max attempt: later retries only add up to 1+retries,
    // so total jobs never exceed 1+retries+staleReverify (chain bound proof in chain.ts).
    const lastAttempt = dueReverify
      ? d.jobs.all().filter((j) => j.rootId === job.rootId).reduce((m, j) => Math.max(m, j.attempt), job.attempt)
      : job.attempt;
    const req: SpawnRequest = dueReverify
      ? { command: job.command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
          rootId: job.rootId, retryOf: job.id, attempt: lastAttempt, staleReverifyOf: job.id }
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
    } else if (dueBackoff) {      // spawn_error: no retry, clear backoff, park the bound task (F32)
      const cur = d.jobs.get(job.id)!;
      const next = { ...cur };
      delete next.retryAt;
      d.jobs.put(next);
      dirty = true;
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "spawn failed");
    } else if (dueReverify) {
      const cur = d.jobs.get(job.id)!;
      d.jobs.put({ ...cur, pendingReverify: false });     // quota exhausted/no slot ⇒ leave nothing pending
      dirty = true;
      if (job.sessionId === d.sessionId) parkTask(d, job.taskId, "no free slot for reverify");
    }
  }
  if (dirty) d.jobs.save();
  return n;
}

/**
 * Roots in this session whose bound task no longer exists (tree rollback, clear, or no taskId at all)
 * are terminal orphans: purge once on the job side so catch-up and timers stop re-evaluating them.
 * The process records remain visible to doctor (`orphanJobs`) and can be reclaimed with bg_kill.
 */
export function reapOrphanRoots(d: SweepDeps): number {
  const board = d.boards.get(d.sessionId);
  const taskIds = new Set(board.tasks.map((t) => t.id));
  let dirty = false;
  let marked = 0;
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId || root.sessionId !== d.sessionId || root.purged) continue;
    if (root.taskId !== undefined && taskIds.has(root.taskId)) continue;
    marked++;
    for (const j of d.jobs.all().filter((x) => x.rootId === root.id)) {
      if (j.purged && j.retryAt == null && j.pendingReverify == null) continue;
      const next = { ...j, purged: true };
      delete next.retryAt;
      delete next.pendingReverify;
      d.jobs.put(next);
      dirty = true;
    }
  }
  if (dirty) d.jobs.save();
  return marked;
}

/** Root-granularity scan set (spec §5.3). */
export function catchUpScan(d: SweepDeps): string[] {
  if (d.boards.get(d.sessionId).counters.halted) return [];      // R20: no catch-up delivery after halt
  const board = d.boards.get(d.sessionId);
  const taskIds = new Set(board.tasks.map((t) => t.id));
  const out: string[] = [];
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId) continue;                 // roots only
    if (root.sessionId !== d.sessionId) continue;
    if (root.purged) continue;                             // R19: purged chains are not delivered again
    if (root.taskId === undefined || !taskIds.has(root.taskId)) continue;   // dangling task: never deliverable
    if (root.finalResult?.trigger === "self") continue;    // R6-5: do not wake self for chains self parked/killed
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
  let boardDirty = false;
  const dd: SweepDeps = { ...d, boardChanged: () => { boardDirty = true; } };
  reapOrphanRoots(dd);
  for (const id of catchUpScan(dd)) {
    if (projectFinal(id, dd.jobs, dd.boards, dd.sessionId, dd.now)) boardDirty = true;
  }
  const respawned = sweepRespawns(dd);
  const catchUp = catchUpScan(dd);
  const retained = applyRetention(dd);
  return { respawned, catchUp, retained, boardDirty };
}

/** Terminal path with no job record: park the bound task directly after failure. */
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
  d.boardChanged?.();
}

/** When taskRetentionMs > 0, clear completed/deleted via the same path as manual settled (§16.7.5). */
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
  d.boardChanged?.();
  return plan.remove.length;
}
