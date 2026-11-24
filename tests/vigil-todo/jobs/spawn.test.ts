import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnJob, readStartStamp, takeChild, trackSpawned } from "../../../src/vigil-todo/jobs/spawn.js";
import { createMonitor } from "../../../src/vigil-todo/jobs/monitor.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-spawn-"));

it("records cwd and startStamp; exit code is real (F48 basics)", async () => {
  const d = dir();
  const r = spawnJob({ command: "pwd", cwd: d }, d, 1);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.job.cwd).toBe(d);
  expect(r.job.exitCodeKnown).toBe(false);   // not yet exited
  expect(r.job.rootId).toBe(r.job.id);
  const mon = createMonitor();
  const code = await new Promise<number | null>((res) => mon.watch(r.job, (j) => res(j.exitCode)));
  expect(code).toBe(0);
  expect(readFileSync(r.job.logPath, "utf8").trim()).toBe(d);
  mon.clearAll();
});

it("a failing command yields a real non-zero exit code", async () => {
  const d = dir();
  const r = spawnJob({ command: "exit 7", cwd: d }, d, 1);
  if (!r.ok) throw new Error(r.error);
  const mon = createMonitor();
  const j = await new Promise<typeof r.job>((res) => mon.watch(r.job, res));
  expect(j.exitCode).toBe(7);
  expect(j.exitCodeKnown).toBe(true);
  expect(j.status).toBe("failed");
  mon.clearAll();
});

it("empty command fails immediately and produces no job", () => {
  const d = dir();
  expect(spawnJob({ command: "   ", cwd: d }, d, 1).ok).toBe(false);
});

it("fpStart is captured by the caller before spawn and recorded verbatim (BLOCKER)", () => {
  const d = dir();
  const r = spawnJob({ command: "true", cwd: d, fpStart: "PRE-SPAWN" }, d, 1);
  if (!r.ok) throw new Error(r.error);
  expect(r.job.fpStart).toBe("PRE-SPAWN");
});

it("invalid cwd returns an error only, without an unhandled error event (BLOCKER)", async () => {
  const d = dir();
  const r = spawnJob({ command: "true", cwd: "/nonexistent-vigil-cwd" }, d, 1);
  expect(r.ok).toBe(false);
  await new Promise((res) => setTimeout(res, 50));
});

it("B3 abandons the child process when registration fails (exception path leaves no orphan process)", () => {
  const d = dir();
  const r = spawnJob({ command: "sleep 30", cwd: d }, d, 1);
  if (!r.ok) throw new Error(r.error);
  const abandoned: string[] = [];
  let watched = false;
  const res = trackSpawned(r.job, () => {}, {
    put: () => { throw new Error("put boom"); },
    save: () => {},
    watch: () => { watched = true; },
    abandon: (j) => abandoned.push(j.id),
  });
  expect(res.ok).toBe(false);
  expect(res).toMatchObject({ error: expect.stringContaining("bookkeeping") });
  expect(abandoned).toEqual([r.job.id]);
  expect(watched).toBe(false);
  takeChild(r.job.id);
  if (r.child.pid) { try { process.kill(-r.child.pid, "SIGKILL"); } catch { /* already cleaned up */ } }
});

it("readStartStamp returns undefined for an invalid pid", () => {
  expect(readStartStamp(999_999)).toBeUndefined();
});

it("default label uses the command prefix; an unwritable log directory returns an error", () => {
  const d = dir();
  const r = spawnJob({ command: "echo hi", cwd: d }, d, 1);
  if (!r.ok) throw new Error(r.error);
  expect(r.job.label).toBe("echo hi");

  const locked = dir();
  chmodSync(locked, 0o500);
  try {
    const w = spawnJob({ command: "true", cwd: locked }, locked, 1);
    expect(w.ok).toBe(false);
  } finally {
    chmodSync(locked, 0o700);
  }
});

it("F168 a caller-provided clock becomes startedAt; otherwise the passed clock is used", () => {
  const d = dir();
  const withNow = spawnJob({ command: "true", cwd: d, now: 4242 }, d, 99);
  expect(withNow.ok).toBe(true);
  if (withNow.ok) {
    expect(withNow.job.startedAt).toBe(4242);
    takeChild(withNow.job.id);
  }

  const fallback = spawnJob({ command: "true", cwd: d }, d, 777);
  expect(fallback.ok).toBe(true);
  if (fallback.ok) {
    expect(fallback.job.startedAt).toBe(777);
    takeChild(fallback.job.id);
  }

  const before = Date.now();
  const implicit = spawnJob({ command: "true", cwd: d }, d, Date.now());
  expect(implicit.ok).toBe(true);
  if (implicit.ok) {
    expect(implicit.job.startedAt).toBeGreaterThanOrEqual(before);
    expect(implicit.job.startedAt).toBeLessThanOrEqual(Date.now());
    takeChild(implicit.job.id);
  }
});

it("a spawn failure (missing cwd) is returned as an error and leaves no child", () => {
  const d = dir();
  const r = spawnJob({ command: "true", cwd: join(d, "does-not-exist") }, d, 1);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
});

it("an empty label falls back to a trimmed command prefix", () => {
  const d = dir();
  const r = spawnJob({ command: "  printf hello  ", cwd: d, label: "   " }, d, 1);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.job.label).toBe("printf hello");
    takeChild(r.job.id);
  }
});
