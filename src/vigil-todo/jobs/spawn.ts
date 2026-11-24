import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./types.js";

export interface SpawnRequest {
  command: string; label?: string; cwd: string; taskId?: number; sessionId?: string;
  rootId?: string; retryOf?: string; attempt?: number; staleReverifyOf?: string;
  fpStart?: string;
  /** Caller-provided clock so the job start and its task's inProgressSince come from one sample. */
  now?: number;
}

export type SpawnResult =
  | { ok: true; job: Job; child: ChildProcess }
  | { ok: false; error: string };

const spawned = new Map<string, ChildProcess>();
export function takeChild(id: string): ChildProcess | undefined {
  const child = spawned.get(id);
  spawned.delete(id);
  return child;
}

export interface TrackDeps {
  put(job: Job): void;
  save(): void;
  watch(job: Job, onExit: (j: Job) => void): void;
  abandon(job: Job): void;
}

/** Post-spawn bookkeeping; if any step fails ⇒ abandon the child (caller kills it), leaving no orphan process (B3). */
export function trackSpawned(job: Job, onExit: (j: Job) => void, d: TrackDeps): { ok: true } | { ok: false; error: string } {
  try {
    d.put(job);
    d.save();
    d.watch(job, onExit);
    return { ok: true };
  } catch (e) {
    d.abandon(job);
    return { ok: false, error: `spawn bookkeeping failed: ${String(e)}` };
  }
}

export function readStartStamp(pid: number): string | undefined {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined; }
  catch { return undefined; }
}

let seq = 0;
const newId = () => `bg_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function spawnJob(req: SpawnRequest, dir: string, now: number): SpawnResult {
  if (!req.command?.trim()) return { ok: false, error: "Command cannot be empty" };
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const logPath = join(dir, `${id}.log`);
  let fd: number;
  try { fd = openSync(logPath, "w"); } catch (e) { return { ok: false, error: `log file: ${String(e)}` }; }
  try {
    const child = spawn("sh", ["-c", req.command], {
      cwd: req.cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PWD: req.cwd },
    });
    // Attach the async error immediately: failure paths like invalid cwd must not become unhandled events
    child.once("error", () => { /* monitor or caller owns semantics; this only prevents a crash */ });
    if (child.pid === undefined) return { ok: false, error: "spawn returned no pid" };
    const job: Job = {
      id, label: req.label?.trim() || req.command.trim().slice(0, 50), command: req.command,
      logPath, cwd: req.cwd, pid: child.pid, status: "running",
      exitCode: null, exitCodeKnown: false, startedAt: req.now ?? now, endedAt: null,
      startStamp: readStartStamp(child.pid),
      fpStart: req.fpStart,
      fpVerdict: "unknown", interferers: [],
      rootId: req.rootId ?? id, retryOf: req.retryOf, attempt: req.attempt ?? 1,
      staleReverifyOf: req.staleReverifyOf,
      taskId: req.taskId, sessionId: req.sessionId,
      evidenceApplied: false, notifyState: "pending",
    };
    spawned.set(id, child);
    return { ok: true, job, child };
  } catch (e) { return { ok: false, error: `spawn failed: ${String(e)}` }; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}
