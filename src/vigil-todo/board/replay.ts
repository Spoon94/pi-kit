import { emptyBoard, type BoardCounters, type BoardState, type Status, type Task } from "./types.js";

const STATUSES = new Set<Status>(["pending", "in_progress", "parked", "completed", "deleted"]);
const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isTask(v: unknown): v is Task {
  if (!isBag(v)) return false;
  return Number.isSafeInteger(v.id) && typeof v.subject === "string" && STATUSES.has(v.status as Status);
}

/** Lenient decode: validate only id/subject/status; keep other fields as-is (superset-compatible). */
export function decodeSnapshot(v: unknown): BoardState | undefined {
  if (!isBag(v) || !Array.isArray(v.tasks) || !v.tasks.every(isTask) || !Number.isSafeInteger(v.nextId)) return undefined;
  const c = isBag(v.counters) ? v.counters : {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const counters: BoardCounters = {
    turnsUsed: num(c.turnsUsed), wakeWatermark: num(c.wakeWatermark), renudgeBudget: num(c.renudgeBudget),
  };
  if (typeof c.halted === "boolean") counters.halted = c.halted;
  if (typeof c.haltedAt === "number" && Number.isFinite(c.haltedAt)) counters.haltedAt = c.haltedAt;
  return {
    tasks: (v.tasks as Task[]).map((t) => ({ ...t, inProgressSince: t.inProgressSince ?? t.statusSince ?? 0 })),
    nextId: v.nextId as number,
    counters,
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
