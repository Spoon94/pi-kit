import { expect, it } from "vitest";
import { createMonitor, recoverJobs } from "../../src/jobs/monitor.js";
import { createJobStore } from "../../src/jobs/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../../src/jobs/types.js";

const base = (o: Partial<Job> = {}): Job => ({
  id: "bg_a", label: "a", command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 999_999,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpVerdict: "unknown", interferers: [], overlapUnfinished: [], rootId: "bg_a", attempt: 1,
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
