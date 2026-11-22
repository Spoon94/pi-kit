import type { JobStore } from "./store.js";
import type { Job } from "./types.js";

export const chainJobs = (store: JobStore, rootId: string): Job[] =>
  store.all().filter((j) => j.rootId === rootId);

/** Chain's last job: take the last in write order (store iteration order), not by millisecond timestamp. */
export const terminalJob = (store: JobStore, rootId: string): Job | undefined => {
  const list = chainJobs(store, rootId);
  return list[list.length - 1] ?? store.get(rootId);
};

/** Walk up retryOf; any ancestor (including self) with staleReverifyOf means a reverify branch. */
export function isReverifyBranch(job: Job, store: JobStore): boolean {
  let cur: Job | undefined = job;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.staleReverifyOf) return true;
    cur = cur.retryOf ? store.get(cur.retryOf) : undefined;
  }
  return false;
}

export const nextAttempt = (job: Job): number => job.attempt + 1;
export const retryDelayMs = (attempt: number, delays: number[]): number =>
  delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 0;

/** Attempt cap = 1 + retries; includes failure retries inside a reverify branch. */
export const canRetry = (job: Job, _store: JobStore, retries: number): boolean =>
  job.attempt < 1 + retries;

/** Reverify quota lives on the chain; descendants of a reverify branch never trigger it again.
 *  Reserve job slots for "reverify + at least one failure retry". */
export function canReverify(job: Job, store: JobStore, staleReverify: number, retries = 0): boolean {
  if (staleReverify <= 0) return false;
  if (isReverifyBranch(job, store)) return false;
  const list = chainJobs(store, job.rootId);
  const used = list.filter((j) => j.staleReverifyOf != null).length;
  if (used >= staleReverify) return false;
  // Bound proof: a reverify job inherits the attempt of the job it reverifies (autofill/sweep respawn),
  // and failure retries stop at attempt=1+retries ⇒ total jobs ≤ list + (1+retries-attempt)
  // ≤ 1+retries+staleReverify. The reserved slot guarantees at least one retry after reverify.
  const maxJobs = 1 + retries + staleReverify;
  const guaranteedRetry = retries > 0 ? 1 : 0;   // a failed reverify can still retry at least once
  return list.length + 1 + guaranteedRetry <= maxJobs;
}

/** Derived termination check (spec §4.5): no running, no retryAt, no pending reverify. */
export function chainTerminated(store: JobStore, rootId: string): boolean {
  const list = chainJobs(store, rootId);
  if (list.length === 0) return true;                       // orphan root
  const root = store.get(rootId);
  if (root?.pendingReverify) return false;
  return list.every((j) => j.status !== "running" && j.retryAt == null);
}
