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
