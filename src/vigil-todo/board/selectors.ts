import type { BoardState, Task } from "./types.js";
import type { Job } from "../jobs/types.js";
import type { JobStore } from "../jobs/store.js";

const settled = (s: Task["status"]) => s === "completed" || s === "deleted";

export const wipCount = (state: BoardState): number =>
  state.tasks.filter((t) => t.status === "in_progress").length;

export function selectNext(state: BoardState, wipLimit: number, capacityFull: boolean): Task | undefined {
  if (capacityFull || wipCount(state) >= wipLimit) return undefined;
  return state.tasks
    .filter((t) => t.status === "pending" && !t.park
      && (t.blockedBy ?? []).every((id) => { const d = state.tasks.find((x) => x.id === id); return d !== undefined && settled(d.status); }))
    .sort((a, b) => a.id - b.id)[0];
}

/** Resolve the distinct roots bound to a task from surviving job records. */
function boundRoots(task: Task, jobs: JobStore): Job[] {
  const roots = new Map<string, Job>();
  for (const id of task.jobs ?? []) {
    const j = jobs.get(id);
    if (!j) continue;
    roots.set(j.rootId, jobs.get(j.rootId) ?? j);
  }
  return [...roots.values()];
}

export function completedSummary(state: BoardState, jobs: JobStore) {
  const visible = state.tasks.filter((t) => t.status !== "deleted");
  const done = visible.filter((t) => t.status === "completed");
  let hasTrace = false;
  let allExit0 = true;
  let evidenceRolled = false;
  let fpUnknown = 0;
  let reverified = 0;

  for (const t of done) {
    const hadJobs = (t.jobs?.length ?? 0) > 0;
    if (!hadJobs && t.lastFailure === undefined) continue;   // manual completion: no job truth to judge
    hasTrace = true;
    const roots = boundRoots(t, jobs);
    if (roots.length > 0) {
      // Job-side truth is authoritative and cannot be evicted by the evidence ring.
      for (const root of roots) {
        if (!root.finalResult) { allExit0 = false; continue; }
        if (!root.finalResult.ok) allExit0 = false;
        if (root.finalResult.reverified) reverified++;
        const terminal = root.finalResult.jobId ? jobs.get(root.finalResult.jobId) ?? root : root;
        if (terminal.fpVerdict === "unknown") fpUnknown++;
      }
      continue;
    }
    // Every bound job record was reclaimed (TTL): fall back to the evictable evidence.
    if (hadJobs) evidenceRolled = true;
    const finals = (t.evidence ?? []).filter((e) => e.chainFinal);
    if (finals.length === 0) { allExit0 = false; continue; }
    if (!finals.every((e) => e.ok && e.exitCode === 0)) allExit0 = false;
    fpUnknown += finals.filter((e) => e.fp === "unknown").length;
    reverified += finals.filter((e) => e.reverified).length;
  }

  return {
    done: done.length,
    total: visible.length,
    allExit0: hasTrace ? allExit0 : true,
    evidenceRolled,
    fpUnknown,
    reverified,
    verifyChanged: done.filter((t) => t.verifyChanged).length,
  };
}
