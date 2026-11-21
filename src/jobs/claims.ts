import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe } from "../lib/atomic.js";

type Kind = "adopt" | "respawn";
const pathOf = (dir: string, rootId: string, kind: Kind) => join(dir, "claims", `${rootId}.${kind}.json`);
const FRESH_GUARD_MS = 1000;

/** O_EXCL 原子创建：已存在即输者。 */
export function claim(dir: string, rootId: string, kind: Kind, me: string, now: number): boolean {
  const p = pathOf(dir, rootId, kind);
  mkdirSync(join(dir, "claims"), { recursive: true });
  let fd: number;
  try { fd = openSync(p, "wx"); } catch { return false; }
  try { writeFileSync(fd, JSON.stringify({ by: me, at: now, pid: process.pid })); } finally { closeSync(fd); }
  return true;
}

export function release(dir: string, rootId: string, kind: Kind): void {
  try { unlinkSync(pathOf(dir, rootId, kind)); } catch { /* 已不存在 */ }
}

/** 过期收回：rename 原子竞争，成功者获重建权（规格 §7.1.1-B）。 */
export function takeoverStale(dir: string, rootId: string, kind: Kind, me: string, isStale: () => boolean): boolean {
  const p = pathOf(dir, rootId, kind);
  const cur = readJsonSafe<{ at?: unknown }>(p);
  if (cur.ok === false) return false;
  // 刚被重建的 claim 不能在同一轮收回，否则顺序执行的两个回收者都会赢（F103）
  if (typeof cur.value.at === "number" && Math.abs(Date.now() - cur.value.at) < FRESH_GUARD_MS) return false;
  if (!isStale()) return false;
  try { renameSync(p, `${p}.stale.${me}`); } catch { return false; }
  return claim(dir, rootId, kind, me, Date.now());
}
