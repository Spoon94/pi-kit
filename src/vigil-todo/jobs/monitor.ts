import type { ChildProcess } from "node:child_process";
import type { Job } from "./types.js";
import type { JobStore } from "./store.js";
import { readStartStamp, takeChild } from "./spawn.js";

export function createMonitor() {
  const stops = new Map<string, () => void>();
  const handlers = new Map<string, (j: Job) => void>();
  const jobs = new Map<string, Job>();

  const emit = (id: string, code: number | null, signal?: string | null) => {
    const j = jobs.get(id);
    if (!j) return;                    // terminated/unregistered ⇒ ignore late duplicate (F31)
    // On termination release all registrations for this job: a long-lived session does not grow linearly with job count (B1)
    const handler = handlers.get(id);
    const stop = stops.get(id);
    jobs.delete(id);
    handlers.delete(id);
    stops.delete(id);
    stop?.();
    j.exitCode = code;
    j.signal = signal ?? null;
    j.exitCodeKnown = code !== null;
    j.endedAt = Date.now();
    j.status = j.kill ? "killed" : code === 0 ? "completed" : "failed";
    handler?.(j);
  };

  const attach = (job: Job, child: ChildProcess): () => void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(() => emit(job.id, child.exitCode, child.signalCode));
      return () => {};
    }
    const onErr = () => emit(job.id, null);
    const onClose = (code: number | null, sig: string | null) => { child.unref(); emit(job.id, code, sig); };
    child.once("error", onErr);
    child.once("close", onClose);
    return () => { child.off("error", onErr); child.off("close", onClose); };
  };

  return {
    watch(job: Job, onExit: (j: Job) => void, child?: ChildProcess): () => void {
      jobs.set(job.id, job); handlers.set(job.id, onExit);
      const proc = child ?? takeChild(job.id);
      if (child) takeChild(job.id);
      let stop: () => void;
      if (proc) {
        stop = attach(job, proc);
      } else {
        // Exit detection for recovered jobs joins the extension's single timer (recoveredExit); no separate 3s poll
        stop = () => {};
      }
      stops.set(job.id, stop);
      return stop;
    },
    clearAll() { for (const s of stops.values()) s(); stops.clear(); handlers.clear(); jobs.clear(); },
    pending: () => stops.size,
    __emitForTest: (id: string, code: number | null) => emit(id, code),
  };
}

/** Liveness check for a recovered job: process gone or startStamp changed ⇒ return terminal state (exit code unknown). */
export function recoveredExit(job: Job, now: number, readStamp: (pid: number) => string | undefined = readStartStamp): Job | undefined {
  if (job.status !== "running") return undefined;
  let alive = false;
  try { process.kill(job.pid, 0); alive = true; } catch { alive = false; }
  if (alive && job.startStamp) alive = readStamp(job.pid) === job.startStamp;
  if (alive) return undefined;
  return { ...job, status: "failed", exitCode: null, exitCodeKnown: false, endedAt: now };
}

/** Restart recovery: process gone ⇒ do not guess the exit code (spec §10.1).
 *  Returns the number of changes; the caller decides whether to save. */
export function recoverJobs(store: JobStore, now: number): number {
  let n = 0;
  for (const j of store.all()) {
    const exited = recoveredExit(j, now);
    if (exited) { store.put(exited); n++; }
  }
  return n;
}
