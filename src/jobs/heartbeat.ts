import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic.js";
import { readStartStamp } from "./spawn.js";

interface Heartbeat { pid: number; startStamp?: string; heartbeatAt: number }
const pathOf = (dir: string, sid: string) => join(dir, "sessions", `${sid}.json`);

export function writeHeartbeat(dir: string, sessionId: string, pid: number, now: number): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeJsonAtomic(pathOf(dir, sessionId), { pid, startStamp: readStartStamp(pid), heartbeatAt: now } satisfies Heartbeat);
}

export function readLiveness(dir: string, sessionId: string, now: number, staleMs: number, hungMs: number):
  "active" | "inactive" | "suspect" {
  const r = readJsonSafe<Heartbeat>(pathOf(dir, sessionId));
  if (r.ok === false) return "inactive";
  const hb = r.value;
  const fresh = now - hb.heartbeatAt < staleMs;
  if (fresh) return "active";
  let alive = false;
  try { process.kill(hb.pid, 0); alive = true; } catch { alive = false; }
  if (alive && hb.startStamp && readStartStamp(hb.pid) !== hb.startStamp) alive = false;  // pid 复用
  if (!alive) return "inactive";
  return now - hb.heartbeatAt > hungMs ? "suspect" : "active";
}

export function removeHeartbeat(dir: string, sessionId: string): void {
  try { unlinkSync(pathOf(dir, sessionId)); } catch { /* 已不存在 */ }
}
