import type { JobFacts } from "./invariants.js";
import type { BoardState, Task } from "./types.js";
import type { JobStore } from "../jobs/store.js";

export type ClearScope = "completed" | "deleted" | "settled" | "all";
export interface CleanupPlan { remove: number[]; skipped: number[]; error?: string }

const inScope = (t: Task, scope: ClearScope): boolean =>
  scope === "all" ? true
  : scope === "completed" ? t.status === "completed"
  : scope === "deleted" ? t.status === "deleted"
  : t.status === "completed" || t.status === "deleted";

export function planCleanup(state: BoardState, scope: ClearScope | undefined, force: boolean | undefined, facts: JobFacts): CleanupPlan {
  const s = scope ?? "settled";
  if (s === "all") {
    if (force !== true) return { remove: [], skipped: [], error: `clear scope:"all" 需要 force:true` };
    const busy = state.tasks.filter((t) => facts.hasRunning(t.id) || facts.hasBackoff(t.id));
    if (busy.length) {
      return { remove: [], skipped: busy.map((t) => t.id),
        error: `${busy.map((t) => `#${t.id}`).join(" ")} 有作业在跑或退避中 → bg_kill({job_id:"…"}) 或 /vigil-todo halt` };
    }
  }
  const remove: number[] = []; const skipped: number[] = [];
  for (const t of state.tasks) {
    if (!inScope(t, s)) continue;
    if (facts.hasRunning(t.id)) { skipped.push(t.id); continue; }   // 部分成功优于孤儿
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

/** 清理任务时同步标记 sidecar，避免 resume 后重放或 catch-up 重新补发（R19）。 */
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
  for (const id of roots) {
    const root = jobs.get(id);
    if (!root) continue;
    const next = { ...root, purged: true };
    delete next.retryAt;
    delete next.pendingReverify;
    jobs.put(next);
  }
  if (roots.size) jobs.save();
  return [...roots];
}

export function retentionCandidates(state: BoardState, retentionMs: number, now: number): number[] {
  if (retentionMs <= 0) return [];
  return state.tasks
    .filter((t) => (t.status === "completed" || t.status === "deleted")
      && (t.statusSince ?? 0) > 0 && now - (t.statusSince ?? 0) > retentionMs)
    .map((t) => t.id);
}
