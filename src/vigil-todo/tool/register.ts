import { appendEvidence } from "../board/evidence.js";
import { applyCleanup, markPurged, planCleanup } from "../board/cleanup.js";
import { checkStructure, type MutationParams, type RuleContext } from "../board/invariants.js";
import { applyMutation } from "../board/reducer.js";
import type { BoardState, Task } from "../board/types.js";
import { admitNewSpawn } from "../jobs/capacity.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { buildResult } from "./envelope.js";
import { BgKillParamsSchema, BgListParamsSchema, BgRunParamsSchema, TodoParamsSchema, prepareTodoArguments } from "./schema.js";
import { DEFAULT_GUIDANCE, type ToolGuidance } from "./guidance.js";
import { sanitizeMultiline } from "../lib/sanitize.js";
import type { TSchema } from "typebox";

export function detectToolConflict(
  allTools: { name: string; sourceInfo?: { source?: string } }[], ownSource: string,
): boolean {
  const t = allTools.find((x) => x.name === "todo");
  if (!t) return false;
  return !(t.sourceInfo?.source ?? "").includes(ownSource);
}

/** L1: best-effort friendly hint; skips nested calls and non-todo tools. */
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
  promptSnippet?: string; promptGuidelines?: string[];
  parameters: TSchema;
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
  content: [{ type: "text", text: sanitizeMultiline(`Error: ${message}`) }], details: { error: message }, isError: true,
});

const asParams = (v: unknown): MutationParams => v as MutationParams;
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

export function createTodoTool(deps: ToolDeps, guidance: ToolGuidance = DEFAULT_GUIDANCE): ToolDef {
  return {
    name: "todo",
    label: "Todo",
    description: "Session task board for multi-step work (create/update/list/get/delete/clear/verify). Long-running commands belong in bg_run; keep exactly one task in_progress and complete only with evidence.",
    promptSnippet: guidance.snippets.todo,
    promptGuidelines: guidance.promptGuidelines,
    parameters: TodoParamsSchema,
    prepareArguments: prepareTodoArguments,
    async execute(raw) {
      const p = asParams(prepareTodoArguments(raw));
      if (p.action === "verify") {
        const before = deps.board();
        const target = before.tasks.find((t) => t.id === p.id);
        if (!target) return errResult(`#${p.id} not found`);
        if (!target.verify) return errResult(`#${target.id} has no verify command → todo({action:"update", id:${target.id}, verify:{kind:"command", command:"…"}})`);
        const r = await deps.runVerify(target.verify.command);
        // Must re-read after await: a manual park, concurrent evidence, or delete may have happened; never overwrite with the old snapshot
        const state = deps.board();
        const task = state.tasks.find((t) => t.id === p.id);
        if (!task || task.status === "deleted") {
          return errResult(`#${p.id} was deleted during verify; evidence discarded, task not revived`);
        }
        const next: Task = { ...task };
        appendEvidence(next, {
          ok: r.ok, kind: "command", origin: "tool", chainFinal: false, at: deps.now(),
          exitCode: r.exitCode, known: r.exitCode !== null, fp: "unknown",
          note: `verify: ${target.verify.command}`,
        });
        const tasks = [...state.tasks]; tasks[state.tasks.indexOf(task)] = next;
        const board = { ...state, tasks };
        const result = buildResult(asRecord(p), board, { kind: "update", id: task.id, from: task.status, to: task.status, changed: true });
        deps.commit(board);
        deps.appendEntry("rpiv-todo-state", result.details);
        if (r.exitCode === null) {
          const message = `Verify command could not run (no bash context or command failed); logged as untrusted evidence → todo({action:"verify", id:${task.id}}) to retry`;
          result.isError = true;
          result.content = [{ type: "text", text: `Error: ${message}` }];
          (result.details as { error?: string }).error = message;
        }
        return result;
      }
      const state = deps.board();
      if (p.action === "clear") {
        const plan = planCleanup(state, p.scope, p.force, deps.ruleCtx().facts);
        if (plan.error) return buildResult(asRecord(p), state, { kind: "error", message: plan.error });
        const next = applyCleanup(state, plan, deps.now());
        const roots = markPurged(deps.jobs, plan.remove, state.tasks);
        const result = buildResult(asRecord(p), next, { kind: "clear", count: plan.remove.length });
        const notes: string[] = [];
        if (plan.skipped.length) notes.push(`skipped (running jobs): ${plan.skipped.map((i) => `#${i}`).join(" ")}`);
        if (roots.length) notes.push(`purged ${roots.length} chains`);
        if (notes.length) result.content[0].text += ` · ${notes.join(" · ")}`;
        deps.commit(next);
        deps.appendEntry("rpiv-todo-state", result.details);
        return result;
      }
      const r = applyMutation(state, p, deps.ruleCtx());
      const result = buildResult(asRecord(p), r.state, r.op);
      const mutated = r.op.kind === "create" || r.op.kind === "delete" || r.op.kind === "clear"
        || (r.op.kind === "update" && r.op.changed);
      if (mutated) {
        deps.commit(r.state);
        deps.appendEntry("rpiv-todo-state", result.details);
        if (r.op.kind === "update" && p.status === "parked") {
          // Spec §7.2: park cancels the whole retry chain in the same synchronous block
          const roots = new Set(deps.jobs.all().filter((j) => j.taskId === p.id).map((j) => j.rootId));
          for (const root of roots) deps.kill(root, "self");
        }
      }
      return result;
    },
  };
}

export function createBgRunTool(deps: ToolDeps, guidance: ToolGuidance = DEFAULT_GUIDANCE): ToolDef {
  return {
    name: "bg_run",
    label: "Background run",
    description: "Start a long-running shell command as a background job bound to a task and return immediately. Use this instead of bash for training/builds/full suites; completion is delivered by a wake message.",
    promptSnippet: guidance.snippets.bg_run,
    promptGuidelines: guidance.promptGuidelines,
    parameters: BgRunParamsSchema,
    async execute(raw) {
      const command = raw.command;
      if (typeof command !== "string" || command.trim() === "") return errResult("Command cannot be empty");
      if (command.length > 100_000) return errResult("Command too long (max 100000)");
      if (command.includes("\u0000")) return errResult("Command contains NUL");
      let label: string | undefined;
      if (raw.label !== undefined) {
        if (typeof raw.label !== "string") return errResult("label must be a string");
        label = raw.label.trim();
        if (label.length > 500) return errResult("label too long (max 500)");
      }
      const state = deps.board();
      let taskId: number | undefined;
      if (raw.task_id !== undefined) {
        if (typeof raw.task_id !== "number" || !Number.isSafeInteger(raw.task_id)) {
          return errResult("task_id must be a safe integer");
        }
        taskId = raw.task_id;
      }
      if (taskId === undefined) {
        const active = state.tasks.filter((t) => t.status === "in_progress");
        if (active.length === 1) taskId = active[0].id;
        else return errResult("task_id required (may be omitted only when exactly one task is in_progress)");
      }
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return errResult(`#${taskId} not found`);
      if (task.status !== "pending" && task.status !== "in_progress") {
        return errResult(`#${taskId} is ${task.status}; cannot start a job`);
      }
      if (task.status === "pending") {
        const reason = checkStructure(state, task, { id: task.id, status: "in_progress" }, deps.ruleCtx());
        if (reason) return errResult(reason);
      }
      if (!admitNewSpawn(deps.jobs, deps.cfg.maxConcurrentJobs)) {
        return errResult(`capacity full (${deps.cfg.maxConcurrentJobs}/${deps.cfg.maxConcurrentJobs} jobs) → bg_kill to free a slot, or retry later (task stays pending, not parked)`);
      }
      const spawned = deps.spawn({
        command, label,
        cwd: deps.cwd(), taskId: task.id, sessionId: deps.sessionId(),
      });
      if (!spawned.ok || !spawned.jobId) return errResult(spawned.error ?? "spawn failed");
      const boundElsewhere = state.tasks.find((t) => t.id !== task.id && (t.jobs ?? []).includes(spawned.jobId!));
      if (boundElsewhere) {
        deps.kill(spawned.jobId, "self");
        return errResult(`${spawned.jobId} is already bound to #${boundElsewhere.id}; a job can bind to only one task`);
      }
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
        return { content: [{ type: "text", text: sanitizeMultiline(`Started ${spawned.jobId} for #${task.id}`) }], details: result.details };
      } catch (e) {
        deps.kill(spawned.jobId, "self");
        return errResult(`bind failed: ${String(e)}; killed ${spawned.jobId}`);
      }
    },
  };
}

export function createBgListTool(deps: ToolDeps, guidance: ToolGuidance = DEFAULT_GUIDANCE): ToolDef {
  return {
    name: "bg_list",
    label: "Background jobs",
    description: "List background jobs with id, status, exit code, label, and command so you can inspect progress or decide what to unblock.",
    promptSnippet: guidance.snippets.bg_list,
    promptGuidelines: guidance.promptGuidelines,
    parameters: BgListParamsSchema,
    async execute() {
      const jobs = deps.jobs.all();
      const text = jobs
        .map((j) => `${j.id} [${j.status}] exit ${j.exitCode ?? "?"} ${j.label}  ${j.command}`)
        .join("\n") || "No background jobs";
      return { content: [{ type: "text", text: sanitizeMultiline(text) }], details: { action: "bg_list", jobs } };
    },
  };
}

export function createBgKillTool(deps: ToolDeps, guidance: ToolGuidance = DEFAULT_GUIDANCE): ToolDef {
  return {
    name: "bg_kill",
    label: "Kill background chain",
    description: "Cancel a whole job chain (the running job plus any retries or backoff). Use only when stopping is intended; otherwise let the job finish.",
    promptSnippet: guidance.snippets.bg_kill,
    promptGuidelines: guidance.promptGuidelines,
    parameters: BgKillParamsSchema,
    async execute(raw) {
      const rawId = raw.job_id;
      if (typeof rawId !== "string" || rawId.trim() === "") return errResult("job_id required");
      const id = rawId.trim();
      const target = deps.jobs.get(id);
      if (!target) return errResult(`${id} not found`);
      if (target.status !== "running" && target.retryAt == null) {
        return errResult(`${id} is ${target.status}; nothing to abort`);
      }
      if (target.kill) {
        return errResult(`kill already requested for ${target.rootId} (${target.kill.requestedBy})`);
      }
      const chain = deps.jobs.all().filter((j) => j.rootId === target.rootId).map((j) => j.id);
      deps.kill(id, "self");
      deps.jobs.save();
      return {
        content: [{ type: "text", text: sanitizeMultiline(`Killed ${target.rootId}: ${chain.join(", ")}`) }],
        details: { action: "bg_kill", rootId: target.rootId, jobs: chain },
      };
    },
  };
}
