import { closeSync, fsyncSync, openSync, renameSync, readFileSync, existsSync, writeFileSync } from "node:fs";

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function readJsonSafe<T>(path: string): { ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" } {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try { return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as T }; }
  catch { return { ok: false, reason: "corrupt" }; }
}

export function quarantine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const moved = `${path}.corrupt-${Date.now()}`;
  try { renameSync(path, moved); return moved; } catch { return undefined; }
}
