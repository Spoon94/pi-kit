import type { Op } from "../board/reducer.js";
import type { BoardCounters, BoardState, Task } from "../board/types.js";
import { sanitizeMultiline } from "../lib/sanitize.js";

export interface Snapshot {
  action: string; params: Record<string, unknown>;
  tasks: Task[]; nextId: number; counters: BoardCounters; error?: string;
}
export interface ToolResult {
  content: { type: "text"; text: string }[]; details: Snapshot; isError?: boolean;
}

function getDetail(task: Task, state: BoardState): string {
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`description: ${task.description}`);
  if (task.activeForm) lines.push(`activeForm: ${task.activeForm}`);
  if (task.owner) lines.push(`owner: ${task.owner}`);
  if (task.verify) lines.push(`verify: ${task.verify.kind} ${task.verify.command}`);
  if (task.verifyChanged) lines.push("verifyChanged: true");
  if (task.blockedBy?.length) lines.push(`blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(" ")}`);
  const blocks = state.tasks
    .filter((t) => t.status !== "deleted" && (t.blockedBy ?? []).includes(task.id))
    .map((t) => `#${t.id}`);
  if (blocks.length) lines.push(`blocks: ${blocks.join(" ")}`);
  if (task.jobs?.length) lines.push(`jobs: ${task.jobs.join(", ")}`);
  const evidence = (task.evidence ?? []).slice(-5);
  if (evidence.length) {
    lines.push(`evidence (last ${evidence.length}):`);
    for (const e of evidence) {
      const parts = [e.ok ? "ok" : "fail", e.kind, e.origin, `fp=${e.fp}`];
      if (e.exitCode !== undefined) parts.push(`exit=${e.exitCode ?? "?"}`);
      if (!e.known) parts.push("known=false");
      if (e.ref) parts.push(`ref=${e.ref}`);
      if (e.trigger) parts.push(`trigger=${e.trigger}`);
      if (e.accepted) parts.push("accepted");
      if (e.note) parts.push(`note=${e.note}`);
      lines.push(`  - ${parts.join(" ")}`);
    }
  }
  const f = task.lastFailure;
  if (f) lines.push(`lastFailure: ref=${f.ref} exit=${f.exitCode ?? "?"} at=${f.at}${f.note ? ` note=${f.note}` : ""}`);
  if (task.park) lines.push(`park: ${task.park.reason} (from ${task.park.from} at ${task.park.at})`);
  if (task.statusSince !== undefined) lines.push(`statusSince: ${task.statusSince}`);
  if (task.inProgressSince !== undefined) lines.push(`inProgressSince: ${task.inProgressSince}`);
  return lines.join("\n");
}

export function buildResult(params: Record<string, unknown>, state: BoardState, op: Op): ToolResult {
  const details: Snapshot = {
    action: String(params.action ?? ""), params,
    tasks: state.tasks, nextId: state.nextId, counters: state.counters,
  };
  if (op.kind === "error") {
    details.error = op.message;
    return { content: [{ type: "text", text: sanitizeMultiline(`Error: ${op.message}`) }], details, isError: true };
  }
  const includeDeleted = params.includeDeleted === true;
  const status = typeof params.status === "string" ? params.status : undefined;
  const listed = state.tasks
    .filter((t) => (includeDeleted || t.status !== "deleted") && (status === undefined || t.status === status))
    .map((t) => `[${t.status}] #${t.id} ${t.subject}`)
    .join("\n") || "No tasks";
  const text =
    op.kind === "create" ? `Created ${op.ids.map((i) => `#${i}`).join(", ")}`
    : op.kind === "update" ? (op.changed ? `Updated #${op.id}${op.from !== op.to ? ` (${op.from} → ${op.to})` : ""}` : `No change: #${op.id}`)
    : op.kind === "delete" ? `Deleted #${op.id}: ${op.subject}`
    : op.kind === "clear" ? `Cleared ${op.count} tasks`
    : op.kind === "get" ? getDetail(op.task, state)
    : listed;
  return { content: [{ type: "text", text: sanitizeMultiline(text) }], details };
}
