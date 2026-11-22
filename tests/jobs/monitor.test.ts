import { expect, it, vi } from "vitest";
import { createMonitor, recoverJobs, recoveredExit } from "../../src/jobs/monitor.js";
import { createJobStore } from "../../src/jobs/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../../src/jobs/types.js";

const base = (o: Partial<Job> = {}): Job => ({
  id: "bg_a", label: "a", command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 999_999,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpVerdict: "unknown", interferers: [], rootId: "bg_a", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("exit and close for the same job call back only once (F31 / Review Focus 3)", async () => {
  const mon = createMonitor();
  let calls = 0;
  const j = base();
  const stop = mon.watch(j, () => { calls++; });
  mon.__emitForTest(j.id, 0);
  mon.__emitForTest(j.id, 0);
  stop();
  expect(calls).toBe(1);
  mon.clearAll();
});

it("per-job registration is released after termination: late duplicates are still ignored (B1/F31)", () => {
  const mon = createMonitor();
  let calls = 0;
  const j = base();
  mon.watch(j, () => { calls++; });
  expect(mon.pending()).toBe(1);
  mon.__emitForTest(j.id, 0);
  expect(calls).toBe(1);
  expect(mon.pending()).toBe(0);
  mon.__emitForTest(j.id, 0);          // late close/error double trigger
  expect(calls).toBe(1);
  mon.clearAll();
});

it("watch with an already-exited child → callback fires once within a microtask", async () => {
  const mon = createMonitor();
  let calls = 0;
  const fake = { exitCode: 0, signalCode: null, once: () => {}, off: () => {}, unref: () => {} };
  mon.watch(base(), () => { calls++; }, fake as never);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(mon.pending()).toBe(0);
  mon.clearAll();
});

it("recovered state does not fake an exit code (F5)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-rec-")));
  s.put(base());
  recoverJobs(s, 1000);
  const j = s.get("bg_a")!;
  expect(j.exitCodeKnown).toBe(false);
  expect(j.exitCode).toBeNull();
  expect(j.status).toBe("failed");
  expect(j.endedAt).toBe(1000);
});

it("recoverJobs returns the number of changes, 0 when nothing changes (P2 write guard)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-rec-")));
  s.put(base());
  expect(recoverJobs(s, 1000)).toBe(1);
  expect(recoverJobs(s, 2000)).toBe(0);
});

it("recoveredExit: process gone → terminal state with unknown exit code (single liveness timer)", () => {
  const j = base({ pid: 999_999, status: "running", endedAt: null });
  const out = recoveredExit(j, 1000);
  expect(out?.status).toBe("failed");
  expect(out?.exitCodeKnown).toBe(false);
  expect(out?.endedAt).toBe(1000);
});

it("recoveredExit: pid alive but startStamp changed counts as gone (pid reuse)", () => {
  const j = base({ pid: process.pid, startStamp: "old", status: "running", endedAt: null });
  expect(recoveredExit(j, 1000, () => "new")?.status).toBe("failed");
  expect(recoveredExit(j, 1000, () => "old")).toBeUndefined();
});

it("watch without a child no longer creates a 3s timer per job", () => {
  vi.useFakeTimers();
  try {
    const mon = createMonitor();
    mon.watch(base({ pid: 999_999 }), () => {});
    expect(vi.getTimerCount()).toBe(0);
    mon.clearAll();
  } finally {
    vi.useRealTimers();
  }
});
