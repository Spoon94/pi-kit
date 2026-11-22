import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { FpVerdict } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { Job } from "../jobs/types.js";

/** HEAD + tracked workspace status hash; undefined when not git or on failure (known blind spot: ignored files not counted). */
export function collectFingerprint(cwd: string): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return createHash("sha1").update(head.trim()).update("\n").update(status).digest("hex").slice(0, 12);
  } catch { return undefined; }
}

const overlaps = (a: Job, b: Job): boolean =>
  a.id !== b.id && a.cwd === b.cwd
  && (a.taskId !== b.taskId || a.sessionId !== b.sessionId)   // excluded only when same task and same session
  && b.startedAt <= (a.endedAt ?? Number.MAX_SAFE_INTEGER)
  && (b.endedAt ?? Number.MAX_SAFE_INTEGER) >= a.startedAt;

/** One set: missing fpEnd (not finished/result unknown) or any write counts as unattributable. */
export function classifyOverlap(job: Job, store: JobStore) {
  const interferers: string[] = [];
  for (const other of store.all()) {
    if (!overlaps(job, other)) continue;
    if (other.fpEnd === undefined || other.fpStart !== other.fpEnd) interferers.push(other.id);
  }
  return { interferers };
}

/** Computed only at autofill; stale only when there are no interferers and the fingerprint changed. */
export function verdictAt(job: Job, store: JobStore): FpVerdict {
  if (job.fpStart === undefined || job.fpEnd === undefined) return "unknown";
  if (job.fpStart === job.fpEnd) return "fresh";
  return classifyOverlap(job, store).interferers.length === 0 ? "stale" : "unknown";
}

export function fpReason(job: Job): string {
  if (job.fpVerdict === "fresh") return "fp:fresh";
  if (job.fpVerdict === "stale") return "fp:stale (workspace changed during exclusive run)";
  if (job.interferers.length > 0) return `fp:unknown (${job.interferers.join(",")} wrote during the run or never finished; unattributable)`;
  if (job.fpStart !== undefined && job.fpEnd !== undefined && job.fpStart !== job.fpEnd) return "fp:unknown (unattributable)";
  return "fp:n/a (not git or collection failed)";
}
