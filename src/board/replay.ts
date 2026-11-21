import { emptyBoard, type BoardState, type Status, type Task } from "./types.js";

const STATUSES = new Set<Status>(["pending", "in_progress", "parked", "completed", "deleted"]);
const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isTask(v: unknown): v is Task {
  if (!isBag(v)) return false;
  return Number.isSafeInteger(v.id) && typeof v.subject === "string" && STATUSES.has(v.status as Status);
}

/** 宽松解码：只校验 id/subject/status，其余字段原样保留（超集兼容）。 */
export function decodeSnapshot(v: unknown): BoardState | undefined {
  if (!isBag(v) || !Array.isArray(v.tasks) || !v.tasks.every(isTask) || !Number.isSafeInteger(v.nextId)) return undefined;
  const c = isBag(v.counters) ? v.counters : {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    tasks: (v.tasks as Task[]).map((t) => ({ ...t, inProgressSince: t.inProgressSince ?? t.statusSince ?? 0 })),
    nextId: v.nextId as number,
    counters: { turnsUsed: num(c.turnsUsed), wakeWatermark: num(c.wakeWatermark), renudgeBudget: num(c.renudgeBudget) },
  };
}

export function replayBranch(entries: Iterable<unknown>): BoardState {
  let fromEntries: BoardState | undefined;
  let fromResults: BoardState | undefined;
  for (const raw of entries) {
    if (!isBag(raw)) continue;
    if (raw.type === "custom") {
      if (raw.customType === "rpiv-todo-state") fromEntries = decodeSnapshot(raw.data) ?? fromEntries;
      continue;
    }
    if (raw.type !== "message" || !isBag(raw.message)) continue;
    const m = raw.message;
    if (m.role === "toolResult" && m.toolName === "todo") fromResults = decodeSnapshot(m.details) ?? fromResults;
  }
  return fromEntries ?? fromResults ?? emptyBoard();
}
