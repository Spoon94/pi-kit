import type { JobFacts } from "./invariants.js";
import type { BoardState, Task } from "./types.js";
import type { JobStore } from "../jobs/store.js";

export type ClearScope = "completed" | "deleted" | "settled" | "all";
export interface CleanupPlan { remove: number[]; skipped: number[]; error?: string }

const SCOPES: ClearScope[] = ["completed", "deleted", "settled", "all"];

const inScope = (t: Task, scope: ClearScope): boolean =>
  scope === "all" ? true
  : scope === "completed" ? t.status === "completed"
  : scope === "deleted" ? t.status === "deleted"
  : t.status === "completed" || t.status === "deleted";

export function planCleanup(state: BoardState, scope: ClearScope | undefined, force: boolean | undefined, facts: JobFacts): CleanupPlan {
  if (scope !== undefined && !SCOPES.includes(scope)) {
    return { remove: [], skipped: [], error: `invalid scope "${String(scope)}" → scope:"completed" | "deleted" | "settled" | "all"` };
  }
  if (force !== undefined && typeof force !== "boolean") {
    return { remove: [], skipped: [], error: `force must be a boolean` };
  }
  const s = scope ?? "settled";
  if (s === "all") {
    if (force !== true) return { remove: [], skipped: [], error: `clear scope:"all" requires force:true` };
    const busy = state.tasks.filter((t) => facts.hasRunning(t.id) || facts.hasBackoff(t.id));
    if (busy.length) {
      return { remove: [], skipped: busy.map((t) => t.id),
        error: `${busy.map((t) => `#${t.id}`).join(" ")} has jobs running or in backoff → bg_kill({job_id:"…"}) or /vigil-todo halt` };
    }
  }
  const remove: number[] = []; const skipped: number[] = [];
  for (const t of state.tasks) {
    if (!inScope(t, s)) continue;
    if (facts.hasRunning(t.id)) { skipped.push(t.id); continue; }   // partial success beats orphans
    remove.push(t.id);
  }
  return { remove, skipped };
}

export function applyCleanup(state: BoardState, plan: CleanupPlan, _now: number): BoardState {
  const drop = new Set(plan.remove);
  const tasks = state.tasks
    .filter((t) => !drop.has(t.id))
    .map((t) => {
      if (!t.blockedBy?.length || !t.blockedBy.some((id) => drop.has(id))) return t;
      const kept = t.blockedBy.filter((id) => !drop.has(id));
      const next = { ...t };
      if (kept.length) next.blockedBy = kept; else delete next.blockedBy;
      return next;
    });
  return { ...state, tasks };
}

/** Mark the sidecar when clearing tasks, so resume/replay or catch-up never redelivers them (R19). */
export function markPurged(jobs: JobStore, taskIds: number[], tasks: Task[]): string[] {
  const drop = new Set(taskIds);
  const roots = new Set<string>();
  for (const t of tasks) {
    if (!drop.has(t.id)) continue;
    for (const id of t.jobs ?? []) {
      const j = jobs.get(id);
      if (j) roots.add(j.rootId);
    }
  }
  let dirty = false;
  for (const id of roots) {
    for (const j of jobs.all().filter((x) => x.rootId === id)) {
      if (j.purged && j.retryAt == null && j.pendingReverify == null) continue;   // idempotent: no change, no save
      const next = { ...j, purged: true };
      delete next.retryAt;
      delete next.pendingReverify;
      jobs.put(next);
      dirty = true;
    }
  }
  if (dirty) jobs.save();
  return [...roots];
}

export function retentionCandidates(state: BoardState, retentionMs: number, now: number): number[] {
  if (retentionMs <= 0) return [];
  return state.tasks
    .filter((t) => (t.status === "completed" || t.status === "deleted")
      && now - (t.statusSince ?? 0) > retentionMs)   // missing/0 = epoch, treated as oldest, always clearable
    .map((t) => t.id);
}
