import type { ChildProcess } from "node:child_process";
import type { Job } from "./types.js";
import type { JobStore } from "./store.js";
import { readStartStamp, takeChild } from "./spawn.js";

export function createMonitor() {
  const fired = new Set<string>();
  const stops = new Map<string, () => void>();
  const handlers = new Map<string, (j: Job) => void>();
  const jobs = new Map<string, Job>();

  const emit = (id: string, code: number | null, signal?: string | null) => {
    if (fired.has(id)) return;                       // F31：exit/close 只生效一次
    fired.add(id);
    const j = jobs.get(id);
    if (!j) return;
    j.exitCode = code;
    j.signal = signal ?? null;
    j.exitCodeKnown = code !== null;
    j.endedAt = Date.now();
    j.status = j.kill ? "killed" : code === 0 ? "completed" : "failed";
    stops.get(id)?.();
    stops.delete(id);
    handlers.get(id)?.(j);
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
        const timer = setInterval(() => {
          try { process.kill(job.pid, 0); } catch { emit(job.id, null); }
        }, 3000);
        timer.unref?.();
        stop = () => clearInterval(timer);
      }
      stops.set(job.id, stop);
      return stop;
    },
    clearAll() { for (const s of stops.values()) s(); stops.clear(); handlers.clear(); jobs.clear(); },
    pending: () => stops.size,
    __emitForTest: (id: string, code: number | null) => emit(id, code),
  };
}

/** 重启恢复：进程已消失 ⇒ 不猜退出码（规格 §10.1）。 */
export function recoverJobs(store: JobStore, now: number): void {
  for (const j of store.all()) {
    if (j.status !== "running") continue;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch { alive = false; }
    if (alive && j.startStamp) {
      // pid 复用防护：startStamp 不一致视为已消失
      alive = readStartStamp(j.pid) === j.startStamp;
    }
    if (alive) continue;
    store.put({ ...j, status: "failed", exitCode: null, exitCodeKnown: false, endedAt: now });
  }
}
