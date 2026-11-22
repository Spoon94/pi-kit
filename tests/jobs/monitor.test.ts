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

it("同一 job 的 exit 与 close 只回调一次（F31 / Review Focus 3）", async () => {
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

it("恢复态不伪造退出码（F5）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-rec-")));
  s.put(base());
  recoverJobs(s, 1000);
  const j = s.get("bg_a")!;
  expect(j.exitCodeKnown).toBe(false);
  expect(j.exitCode).toBeNull();
  expect(j.status).toBe("failed");
  expect(j.endedAt).toBe(1000);
});

it("recoverJobs 返回改动条数，无变化为 0（P2 落盘守卫）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-rec-")));
  s.put(base());
  expect(recoverJobs(s, 1000)).toBe(1);
  expect(recoverJobs(s, 2000)).toBe(0);
});

it("recoveredExit：进程消失 ⇒ 终态且退出码未知（单 timer 探活）", () => {
  const j = base({ pid: 999_999, status: "running", endedAt: null });
  const out = recoveredExit(j, 1000);
  expect(out?.status).toBe("failed");
  expect(out?.exitCodeKnown).toBe(false);
  expect(out?.endedAt).toBe(1000);
});

it("recoveredExit：pid 存活但 startStamp 变化视为消失（pid 复用）", () => {
  const j = base({ pid: process.pid, startStamp: "old", status: "running", endedAt: null });
  expect(recoveredExit(j, 1000, () => "new")?.status).toBe("failed");
  expect(recoveredExit(j, 1000, () => "old")).toBeUndefined();
});

it("无 child 的 watch 不再创建每作业 3s timer", () => {
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
