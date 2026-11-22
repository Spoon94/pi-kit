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
        // 恢复作业的退出检测并入扩展的单 timer（recoveredExit），不另起 3s 轮询
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

/** 恢复作业探活：进程消失或 startStamp 变化 ⇒ 返回终态（退出码未知）。 */
export function recoveredExit(job: Job, now: number, readStamp: (pid: number) => string | undefined = readStartStamp): Job | undefined {
  if (job.status !== "running") return undefined;
  let alive = false;
  try { process.kill(job.pid, 0); alive = true; } catch { alive = false; }
  if (alive && job.startStamp) alive = readStamp(job.pid) === job.startStamp;
  if (alive) return undefined;
  return { ...job, status: "failed", exitCode: null, exitCodeKnown: false, endedAt: now };
}

/** 重启恢复：进程已消失 ⇒ 不猜退出码（规格 §10.1）。返回改动条数，调用方据此决定是否落盘。 */
export function recoverJobs(store: JobStore, now: number): number {
  let n = 0;
  for (const j of store.all()) {
    const exited = recoveredExit(j, now);
    if (exited) { store.put(exited); n++; }
  }
  return n;
}
