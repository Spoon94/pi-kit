import type { BoardState, Status, Task } from "./types.js";

export const TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
  pending: new Set<Status>(["in_progress", "parked", "completed", "deleted"]),
  in_progress: new Set<Status>(["completed", "parked", "pending", "deleted"]),
  parked: new Set<Status>(["in_progress", "pending", "completed", "deleted"]),
  completed: new Set<Status>(["deleted"]),
  deleted: new Set<Status>(),
};

export function isTransitionValid(from: Status, to: Status): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export interface JobFacts {
  hasRunning(taskId: number): boolean;
  hasBackoff(taskId: number): boolean;
  startedAt(ref: string): number | undefined;
  exists(jobId: string): boolean;
}
export interface RuleContext { wipLimit: number; facts: JobFacts; now: number }
export interface UpdateParams {
  id: number; status?: Status; reason?: string;
}

const settled = (s: Status) => s === "completed" || s === "deleted";

/** 结构性规则；证据类规则在 evidence.ts。返回错误文案或 undefined。 */
export function checkStructure(state: BoardState, task: Task, p: UpdateParams, ctx: RuleContext): string | undefined {
  if (p.status !== undefined && !isTransitionValid(task.status, p.status)) {
    return `illegal transition ${task.status} → ${p.status}`;
  }

  // R14 让位前置：作业在跑时不得释放 WIP 名额
  const yielding = task.status === "in_progress" && p.status === "pending";
  if (yielding && (ctx.facts.hasRunning(task.id) || ctx.facts.hasBackoff(task.id))) {
    return `#${task.id} has a running job; cannot yield → bg_kill({job_id:"…"}) 或等它结束`;
  }

  // R1 WIP
  if (p.status === "in_progress" && task.status !== "in_progress") {
    const active = state.tasks.filter((x) => x.status === "in_progress");
    if (active.length >= ctx.wipLimit) {
      return `WIP full (${active.length}/${ctx.wipLimit}): ${active.map((x) => `#${x.id}`).join(" ")}`
        + ` → todo({action:"update", id:${active[0].id}, status:"parked", reason:"…"})`;
    }
  }

  // R4 依赖（R21 环检测在 reducer/graph.ts：提议边并入后 DFS，回边即拒）
  if (p.status === "in_progress" || p.status === "completed") {
    for (const dep of task.blockedBy ?? []) {
      const d = state.tasks.find((x) => x.id === dep);
      if (!d) return `#${task.id} blocked by #${dep} (missing) → todo({action:"update", id:${task.id}, removeBlockedBy:[${dep}]})`;
      if (!settled(d.status)) {
        return `#${task.id} is blocked by #${d.id} (${d.status}) → todo({action:"update", id:${task.id}, removeBlockedBy:[${d.id}]})`;
      }
    }
  }
  return undefined;
}

export interface CreateItem {
  subject: string; description?: string; activeForm?: string;
  blockedBy?: number[]; owner?: string; metadata?: Record<string, unknown>;
  verify?: { kind: "command"; command: string };
}
export interface MutationParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear" | "verify";
  id?: number; subject?: string; description?: string; activeForm?: string; owner?: string;
  status?: Status; reason?: string; accept?: "stale";
  blockedBy?: number[]; addBlockedBy?: number[]; removeBlockedBy?: number[];
  metadata?: Record<string, unknown>; tasks?: CreateItem[]; includeDeleted?: boolean;
  verify?: { kind: "command"; command: string };
  scope?: "completed" | "deleted" | "settled" | "all"; force?: boolean;
  [k: string]: unknown;
}
export const READONLY_FIELDS = [
  "jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged",
  "halted", "haltedAt",
] as const;
