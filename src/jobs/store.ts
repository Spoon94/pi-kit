import { mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { quarantine, readJsonSafe, writeJsonAtomic } from "../lib/atomic.js";
import type { Job } from "./types.js";

export function projectHash(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export const runDir = (cwd: string): string => join("/tmp/bg-run", projectHash(cwd));

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
    /** logPath 必须落在本 store 的 runDir 内（防 sidecar 被篡改后读任意文件）。 */
    isSafeLogPath: (p: string): boolean => {
      if (typeof p !== "string" || p === "") return false;
      const rel = relative(dir, p);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    },
    save: () => { ensure(); writeJsonAtomic(path, { jobs: [...jobs.values()] }); },
    load: (): { degraded: boolean; note?: string } => {
      ensure();
      const r = readJsonSafe<{ jobs?: unknown }>(path);
      if (r.ok === false) {
        if (r.reason === "missing") return { degraded: false };
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar 损坏，已留档 ${moved ?? "(未移动)"}，从空开始` };
      }
      const list = r.value?.jobs;
      if (!Array.isArray(list) || !list.every(isJob)) {
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar 结构非法，已留档 ${moved ?? "(未移动)"}，从空开始` };
      }
      jobs = new Map(list.map((j) => [j.id, j]));
      return { degraded: false };
    },
    gc: (ttlMs: number, now: number): number => {
      let removed = 0;
      for (const j of [...jobs.values()]) {
        if (j.status === "running" || j.retryAt != null) continue;
        if (j.endedAt != null && now - j.endedAt >= ttlMs) {
          jobs.delete(j.id);
          removed++;
          try { unlinkSync(j.logPath); } catch { /* 日志可能已被删 */ }
        }
      }
      return removed;
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
