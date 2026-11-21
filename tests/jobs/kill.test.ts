import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { requestKill } from "../../src/jobs/kill.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 999_999,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("按 rootId 取消整链：清 retryAt 并记 requestedBy（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  const r = requestKill(s, "R", "self", 1000);
  expect(r.cancelledBackoff.sort()).toEqual(["R", "R2"]);
  expect(s.get("R")?.retryAt).toBeUndefined();
  expect(s.get("R")?.kill).toEqual({ requestedBy: "self", at: 1000 });
});

it("按链上任意 id 也能定位 root（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  expect(requestKill(s, "R2", "external", 1000).cancelledBackoff).toHaveLength(2);
});

it("未知 id 返回空结果，不抛", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  expect(requestKill(s, "nope", "self", 1)).toEqual({ killed: [], cancelledBackoff: [] });
});
