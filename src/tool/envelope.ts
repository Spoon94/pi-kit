import type { Op } from "../board/reducer.js";
import type { BoardCounters, BoardState, Task } from "../board/types.js";

export interface Snapshot {
  action: string; params: Record<string, unknown>;
  tasks: Task[]; nextId: number; counters: BoardCounters; error?: string;
}
export interface ToolResult {
  content: { type: "text"; text: string }[]; details: Snapshot; isError?: boolean;
}

export function buildResult(params: Record<string, unknown>, state: BoardState, op: Op): ToolResult {
  const details: Snapshot = {
    action: String(params.action ?? ""), params,
    tasks: state.tasks, nextId: state.nextId, counters: state.counters,
  };
  if (op.kind === "error") {
    details.error = op.message;
    return { content: [{ type: "text", text: `Error: ${op.message}` }], details, isError: true };
  }
  const text =
    op.kind === "create" ? `Created ${op.ids.map((i) => `#${i}`).join(", ")}`
    : op.kind === "update" ? (op.changed ? `Updated #${op.id}${op.from !== op.to ? ` (${op.from} → ${op.to})` : ""}` : `No change: #${op.id}`)
    : op.kind === "delete" ? `Deleted #${op.id}: ${op.subject}`
    : op.kind === "clear" ? `Cleared ${op.count} tasks`
    : op.kind === "get" ? `#${op.task.id} [${op.task.status}] ${op.task.subject}`
    : state.tasks.filter((t) => t.status !== "deleted").map((t) => `[${t.status}] #${t.id} ${t.subject}`).join("\n") || "No tasks";
  return { content: [{ type: "text", text }], details };
}
