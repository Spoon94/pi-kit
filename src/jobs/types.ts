import type { FpVerdict } from "../board/types.js";

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface Job {
  id: string; label: string; command: string; logPath: string; cwd: string;
  pid: number; status: JobStatus;
  exitCode: number | null; signal?: string | null; exitCodeKnown: boolean;
  startedAt: number; endedAt: number | null; startStamp?: string;
  fpStart?: string; fpEnd?: string; fpVerdict: FpVerdict;
  interferers: string[]; overlapUnfinished: string[];
  staleReverifyOf?: string;
  taskId?: number; sessionId?: string;
  rootId: string; retryOf?: string; attempt: number;
  retryAt?: number;
  finalized?: boolean;
  finalResult?: { ok: boolean; note: string; trigger: "self" | "external"; at: number };
  pendingReverify?: boolean;
  kill?: { requestedBy: "self" | "external"; at: number };
  evidenceApplied: boolean;
  notifyState: "pending" | "sent" | "acked";
  notifySentAt?: number; wakeId?: string;
}
