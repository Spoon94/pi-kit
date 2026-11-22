import { mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { quarantine, readJsonSafe, writeJsonAtomic } from "../lib/atomic.js";
import type { Job } from "./types.js";

export function projectHash(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export const runDir = (cwd: string): string => join("/tmp/bg-run", projectHash(cwd));

/** Hard cap on terminal records: a 7-day TTL can still accumulate tens of thousands at high
 *  throughput (see B4); reclaim oldest complete chains first. */
export const MAX_JOB_RECORDS = 2000;

const isJob = (v: unknown): v is Job => {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return typeof j.id === "string" && typeof j.rootId === "string" && typeof j.command === "string"
    && typeof j.status === "string" && typeof j.attempt === "number";
};

export function createJobStore(dir: string) {
  const path = join(dir, "jobs.json");
  let jobs = new Map<string, Job>();
  const ensure = () => mkdirSync(dir, { recursive: true });
  return {
    all: (): Job[] => [...jobs.values()],
    get: (id: string) => jobs.get(id),
    put: (j: Job) => { jobs.set(j.id, { ...j }); },
    /**
     * logPath must live inside this store's runDir:
     * 1) a cheap relative check blocks absolute paths/..; 2) realpath containment blocks symlink escapes inside runDir.
     * A nonexistent path (realpath throws) is always rejected, never allowed.
     */
    isSafeLogPath: (p: string): boolean => {
      if (typeof p !== "string" || p === "") return false;
      const rel = relative(dir, p);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
      try {
        const realDir = realpathSync(dir);
        const realFile = realpathSync(p);
        const realRel = relative(realDir, realFile);
        return realRel !== "" && !realRel.startsWith("..") && !isAbsolute(realRel);
      } catch {
        return false;
      }
    },
    save: () => { ensure(); writeJsonAtomic(path, { jobs: [...jobs.values()] }); },
    load: (): { degraded: boolean; note?: string } => {
      ensure();
      const r = readJsonSafe<{ jobs?: unknown }>(path);
      if (r.ok === false) {
        if (r.reason === "missing") return { degraded: false };
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar corrupted, archived ${moved ?? "(not moved)"}, starting empty` };
      }
      const list = r.value?.jobs;
      if (!Array.isArray(list) || !list.every(isJob)) {
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar structure invalid, archived ${moved ?? "(not moved)"}, starting empty` };
      }
      jobs = new Map(list.map((j) => [j.id, j]));
      return { degraded: false };
    },
    gc: (ttlMs: number, now: number, maxRecords = MAX_JOB_RECORDS): number => {
      let removed = 0;
      const drop = (j: Job): void => {
        jobs.delete(j.id);
        removed++;
        try { unlinkSync(j.logPath); } catch { /* log may already be deleted */ }
      };
      for (const j of [...jobs.values()]) {
        if (j.status === "running" || j.retryAt != null) continue;
        if (j.endedAt != null && now - j.endedAt >= ttlMs) drop(j);
      }
      if (jobs.size <= maxRecords) return removed;
      // Reclaim only records whose whole chain is terminated + projected + acked/self; leave unterminated chains to finalize
      const doneRoots = new Set<string>();
      for (const j of jobs.values()) {
        if (j.id === j.rootId && j.finalized && j.evidenceApplied
          && (j.notifyState === "acked" || j.finalResult?.trigger === "self")) doneRoots.add(j.id);
      }
      const oldest = [...jobs.values()]
        .filter((j) => doneRoots.has(j.rootId) && j.status !== "running" && j.retryAt == null)
        .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
      for (const j of oldest) {
        if (jobs.size <= maxRecords) break;
        drop(j);
      }
      return removed;
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
