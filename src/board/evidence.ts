import type { JobFacts } from "./invariants.js";
import { EVIDENCE_RING, type Evidence, type LastFailure, type Task } from "./types.js";

/** R2/R3/R5/R6: return passing evidence that meets all criteria, else undefined. */
export function passingEvidence(task: Task, facts: JobFacts, accept?: "stale"): Evidence | undefined {
  const since = task.inProgressSince ?? 0;
  return (task.evidence ?? []).find((e) => {
    if (!e.ok || !e.known) return false;                                  // R5
    if (e.fp === "stale" && !(accept === "stale" || e.accepted)) return false; // R6
    if (since === 0) return true;                                         // R2-7 migrated state
    if (e.kind === "job") {
      const started = e.ref ? facts.startedAt(e.ref) : undefined;
      return started !== undefined && started >= since && e.at >= started;
    }
    return e.at >= since;                                                 // R2-6 verify/manual
  });
}

/** Completion gate; returns the rejection message or undefined. */
export function completionGate(task: Task, facts: JobFacts, accept?: "stale"): string | undefined {
  const f = task.lastFailure;
  if (f && !(task.evidence ?? []).some((e) => e.ok && e.known && e.at > f.at)) {
    return `#${task.id} has unresolved failure (${f.ref} exit ${f.exitCode}) → todo({action:"verify", id:${task.id}})`;
  }
  const needsEvidence = (task.jobs?.length ?? 0) > 0 || task.verify !== undefined;
  if (!needsEvidence) return undefined;
  const pass = passingEvidence(task, facts, accept);
  if (pass) return undefined;
  const staleOnly = (task.evidence ?? []).some((e) => e.ok && e.known && e.fp === "stale");
  if (staleOnly && accept !== "stale") {
    return `#${task.id} evidence stale → todo({action:"update", id:${task.id}, status:"completed", accept:"stale"}) or todo({action:"verify", id:${task.id}})`;
  }
  return `#${task.id} has no passing evidence since it started → todo({action:"verify", id:${task.id}})`;
}

export function recordFailure(task: Task, f: LastFailure): void { task.lastFailure = f; }

export function appendEvidence(task: Task, e: Evidence): void {
  task.evidence = [...(task.evidence ?? []), e].slice(-EVIDENCE_RING);
}
