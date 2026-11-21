export type Status = "pending" | "in_progress" | "parked" | "completed" | "deleted";
export type FpVerdict = "fresh" | "stale" | "unknown";

export interface Evidence {
  ok: boolean;
  kind: "job" | "command" | "manual";
  origin: "async" | "tool";
  chainFinal: boolean;
  trigger?: "self" | "external";
  at: number;
  exitCode?: number | null;
  known: boolean;
  fp: FpVerdict;
  accepted?: boolean;
  ref?: string;
  note?: string;
}

export interface LastFailure { exitCode: number | null; ref: string; at: number; note?: string }

export interface Task {
  id: number; subject: string; status: Status;
  description?: string; activeForm?: string; owner?: string;
  blockedBy?: number[]; metadata?: Record<string, unknown>;
  verify?: { kind: "command"; command: string };
  verifyChanged?: boolean;
  jobs?: string[];
  evidence?: Evidence[];
  lastFailure?: LastFailure;
  statusSince?: number;
  inProgressSince?: number;
  park?: { reason: string; at: number; from: Status };
  defer?: { untilRoot: string; reason: string; at: number };
}

export interface BoardCounters {
  turnsUsed: number; wakeWatermark: number; renudgeBudget: number;
  halted?: boolean; haltedAt?: number;
}
export interface BoardState { tasks: Task[]; nextId: number; counters: BoardCounters }

export const EVIDENCE_RING = 8;

export function emptyBoard(): BoardState {
  return { tasks: [], nextId: 1, counters: { turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 } };
}
