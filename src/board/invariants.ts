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
  defer?: { untilJob: string; reason: string } | null;
}

const settled = (s: Status) => s === "completed" || s === "deleted";

/** 结构性规则；证据类规则在 evidence.ts。返回错误文案或 undefined。 */
export function checkStructure(state: BoardState, task: Task, p: UpdateParams, ctx: RuleContext): string | undefined {
  const away = task.metadata?.adoptedAway as { session?: string } | undefined;
  if (away) return `#${task.id} 已移交到会话 ${away.session ?? "?"}，请在该会话操作`;

  if (p.status !== undefined && !isTransitionValid(task.status, p.status)) {
    return `illegal transition ${task.status} → ${p.status}`;
  }

  // R13 互斥（先判，避免后续规则给出误导文案）
  if (p.defer && task.status === "parked") {
    return `#${task.id} is parked; 先 todo({action:"update", id:${task.id}, status:"pending"}) 再 defer`;
  }
  if (p.status === "parked" && task.defer) {
    return `#${task.id} is deferred; 先 todo({action:"update", id:${task.id}, defer:null}) 再 park`;
  }

  // R14 让位 / defer 前置
  const yielding = task.status === "in_progress" && p.status === "pending";
  if ((yielding || p.defer) && (ctx.facts.hasRunning(task.id) || ctx.facts.hasBackoff(task.id))) {
    return `#${task.id} has a running job; cannot yield or defer → bg_kill({job_id:"…"}) 或等它结束`;
  }

  // R9 deferred 不许直接开工
  if (p.status === "in_progress" && task.defer) {
    return `#${task.id} is deferred → ${task.defer.untilRoot} → todo({action:"update", id:${task.id}, defer:null})`;
  }

  // R1 WIP
  if (p.status === "in_progress" && task.status !== "in_progress") {
    const active = state.tasks.filter((x) => x.status === "in_progress");
    if (active.length >= ctx.wipLimit) {
      return `WIP full (${active.length}/${ctx.wipLimit}): ${active.map((x) => `#${x.id}`).join(" ")}`
        + ` → todo({action:"update", id:${active[0].id}, status:"parked", reason:"…"})`;
    }
  }

  // R4 依赖
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
  defer?: { untilJob: string; reason: string } | null;
  scope?: "completed" | "deleted" | "settled" | "all"; force?: boolean;
  [k: string]: unknown;
}
export const READONLY_FIELDS = [
  "jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged",
  "halted", "haltedAt",
] as const;
