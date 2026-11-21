import { appendEvidence } from "../board/evidence.js";
import { checkStructure, type MutationParams, type RuleContext } from "../board/invariants.js";
import { applyMutation } from "../board/reducer.js";
import type { BoardState, Task } from "../board/types.js";
import { admitNewSpawn } from "../jobs/capacity.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { buildResult } from "./envelope.js";
import { BgKillParamsSchema, BgRunParamsSchema, TodoParamsSchema, prepareTodoArguments } from "./schema.js";

export function detectToolConflict(
  allTools: { name: string; sourceInfo?: { source?: string } }[], ownSource: string,
): boolean {
  const t = allTools.find((x) => x.name === "todo");
  if (!t) return false;
  return !(t.sourceInfo?.source ?? "").includes(ownSource);
}

/** L1：尽力而为的友好提示，跳过嵌套调用与非 todo 工具。 */
export function preflight(
  event: { toolName: string; input?: unknown; parentToolCallId?: string },
  state: BoardState, ctx: RuleContext,
): { block: true; reason: string } | undefined {
  if (event.toolName !== "todo" || event.parentToolCallId) return undefined;
  const input = event.input;
  if (typeof input !== "object" || input === null) return undefined;
  const p = input as MutationParams;
  if (p.action !== "update" || typeof p.id !== "number") return undefined;
  const task = state.tasks.find((t) => t.id === p.id);
  if (!task) return undefined;
  const reason = checkStructure(state, task, p as never, ctx);
  return reason ? { block: true, reason } : undefined;
}

export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
}
export interface ToolDef {
  name: string; label: string; description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  execute(params: Record<string, unknown>): Promise<ToolResultLike>;
}

export interface ToolDeps {
  sessionId(): string;
  cwd(): string;
  board(): BoardState;
  commit(state: BoardState): void;
  appendEntry(type: string, data: unknown): void;
  ruleCtx(): RuleContext;
  jobs: JobStore;
  cfg: VigilConfig;
  spawn(req: SpawnRequest): { ok: boolean; error?: string; jobId?: string };
  kill(idOrRoot: string, by: "self" | "external"): void;
  runVerify(command: string): Promise<{ ok: boolean; exitCode: number | null }>;
  now(): number;
}

const errResult = (message: string): ToolResultLike => ({
  content: [{ type: "text", text: `Error: ${message}` }], details: { error: message }, isError: true,
});

const asParams = (v: unknown): MutationParams => v as MutationParams;
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

export function createTodoTool(deps: ToolDeps): ToolDef {
  return {
    name: "todo",
    label: "Todo",
    description: "Manage the session task board (create/update/list/get/delete/clear/verify).",
    parameters: TodoParamsSchema,
    prepareArguments: prepareTodoArguments,
    async execute(raw) {
      const p = asParams(prepareTodoArguments(raw));
      if (p.action === "verify") {
        const state = deps.board();
        const task = state.tasks.find((t) => t.id === p.id);
        if (!task) return errResult(`#${p.id} not found`);
        if (!task.verify) return errResult(`#${task.id} has no verify command → todo({action:"update", id:${task.id}, verify:{kind:"command", command:"…"}})`);
        const r = await deps.runVerify(task.verify.command);
        const next: Task = { ...task };
        appendEvidence(next, {
          ok: r.ok, kind: "command", origin: "tool", chainFinal: false, at: deps.now(),
          exitCode: r.exitCode, known: r.exitCode !== null, fp: "unknown",
          note: `verify: ${task.verify.command}`,
        });
        const tasks = [...state.tasks]; tasks[state.tasks.indexOf(task)] = next;
        const board = { ...state, tasks };
        const result = buildResult(asRecord(p), board, { kind: "update", id: task.id, from: task.status, to: task.status, changed: true });
        deps.commit(board);
        deps.appendEntry("rpiv-todo-state", result.details);
        return result;
      }
      const state = deps.board();
      const r = applyMutation(state, p, deps.ruleCtx());
      const result = buildResult(asRecord(p), r.state, r.op);
      const mutated = r.op.kind === "create" || r.op.kind === "delete" || r.op.kind === "clear"
        || (r.op.kind === "update" && r.op.changed);
      if (mutated) {
        deps.commit(r.state);
        deps.appendEntry("rpiv-todo-state", result.details);
      }
      return result;
    },
  };
}

export function createBgRunTool(deps: ToolDeps): ToolDef {
  return {
    name: "bg_run",
    label: "Background run",
    description: "Start a background shell job bound to a task.",
    parameters: BgRunParamsSchema,
    async execute(raw) {
      const command = raw.command;
      if (typeof command !== "string" || command.trim() === "") return errResult("Command cannot be empty");
      const state = deps.board();
      let taskId = typeof raw.task_id === "number" ? raw.task_id : undefined;
      if (taskId === undefined) {
        const active = state.tasks.filter((t) => t.status === "in_progress");
        if (active.length === 1) taskId = active[0].id;
        else return errResult("task_id required（仅唯一 in_progress 时可省）");
      }
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return errResult(`#${taskId} not found`);
      if (task.status !== "pending" && task.status !== "in_progress") {
        return errResult(`#${taskId} is ${task.status}; 不能起作业`);
      }
      if (task.status === "pending") {
        const reason = checkStructure(state, task, { id: task.id, status: "in_progress" }, deps.ruleCtx());
        if (reason) return errResult(reason);
      }
      if (!admitNewSpawn(deps.jobs, deps.cfg.maxConcurrentJobs)) {
        return errResult(`capacity full (${deps.cfg.maxConcurrentJobs}/${deps.cfg.maxConcurrentJobs} jobs) → bg_kill 释放，或稍后再试（任务保持 pending，未被 park）`);
      }
      const spawned = deps.spawn({
        command, label: typeof raw.label === "string" ? raw.label : undefined,
        cwd: deps.cwd(), taskId: task.id, sessionId: deps.sessionId(),
      });
      if (!spawned.ok || !spawned.jobId) return errResult(spawned.error ?? "spawn failed");
      try {
        const next: Task = { ...task, jobs: [...(task.jobs ?? []), spawned.jobId] };
        if (task.status === "pending") {
          next.status = "in_progress"; next.statusSince = deps.now(); next.inProgressSince = deps.now();
        }
        const idx = state.tasks.indexOf(task);
        const tasks = [...state.tasks]; tasks[idx] = next;
        const board = { ...state, tasks };
        const result = buildResult({ action: "update", id: task.id }, board, {
          kind: "update", id: task.id, from: task.status, to: next.status, changed: true,
        });
        deps.commit(board);
        deps.appendEntry("rpiv-todo-state", result.details);
        return { content: [{ type: "text", text: `Started ${spawned.jobId} for #${task.id}` }], details: result.details };
      } catch (e) {
        deps.kill(spawned.jobId, "self");
        return errResult(`bind failed: ${String(e)}; 已 kill ${spawned.jobId}`);
      }
    },
  };
}

export function createBgListTool(deps: ToolDeps): ToolDef {
  return {
    name: "bg_list",
    label: "Background jobs",
    description: "List background jobs with status and exit codes.",
    parameters: undefined,
    async execute() {
      const jobs = deps.jobs.all();
      const text = jobs
        .map((j) => `${j.id} [${j.status}] exit ${j.exitCode ?? "?"} ${j.label}  ${j.command}`)
        .join("\n") || "No background jobs";
      return { content: [{ type: "text", text }], details: { action: "bg_list", jobs } };
    },
  };
}

export function createBgKillTool(deps: ToolDeps): ToolDef {
  return {
    name: "bg_kill",
    label: "Kill background chain",
    description: "Kill a running job and cancel its whole retry chain (accepts any job id or root id).",
    parameters: BgKillParamsSchema,
    async execute(raw) {
      const id = raw.job_id;
      if (typeof id !== "string") return errResult("job_id required");
      const target = deps.jobs.get(id);
      if (!target) return errResult(`${id} not found`);
      const chain = deps.jobs.all().filter((j) => j.rootId === target.rootId).map((j) => j.id);
      deps.kill(id, "self");
      deps.jobs.save();
      return {
        content: [{ type: "text", text: `Killed ${target.rootId}: ${chain.join(", ")}` }],
        details: { action: "bg_kill", rootId: target.rootId, jobs: chain },
      };
    },
  };
}
