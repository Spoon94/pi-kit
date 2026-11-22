import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { jobFactsOf } from "../../../src/vigil-todo/jobs/facts.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 5, endedAt: 6,
  fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1, taskId: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("jobFactsOf exposes four facts: running/backoff/startedAt/exists", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-facts-")));
  s.put(j("run", { status: "running", taskId: 1, startedAt: 42 }));
  s.put(j("back", { taskId: 2, retryAt: 99, startedAt: 7 }));
  const f = jobFactsOf(s);
  expect(f.hasRunning(1)).toBe(true);
  expect(f.hasRunning(2)).toBe(false);
  expect(f.hasBackoff(2)).toBe(true);
  expect(f.hasBackoff(1)).toBe(false);
  expect(f.startedAt("run")).toBe(42);
  expect(f.startedAt("missing")).toBeUndefined();
  expect(f.exists("run")).toBe(true);
  expect(f.exists("missing")).toBe(false);
});
