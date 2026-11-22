import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyOverlap, collectFingerprint, fpReason, verdictAt } from "../../../src/vigil-todo/lib/fingerprint.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";

const gitDir = () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_4m3nbyzh}}"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  writeFileSync(join(d, "a.txt"), "a");
  execFileSync("git", ["add", "."], { cwd: d });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: d });
  return d;
};
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 100, endedAt: 200,
  fpStart: "A", fpEnd: "A", fpVerdict: "unknown", interferers: [],
  rootId: id, attempt: 1, evidenceApplied: false, notifyState: "pending", ...o,
});

it("git directory is collectable; the fingerprint changes after modification", () => {
  const d = gitDir();
  const a = collectFingerprint(d);
  expect(a).toBeDefined();
  writeFileSync(join(d, "a.txt"), "b");
  expect(collectFingerprint(d)).not.toBe(a);
});

it("non-git directory returns undefined (F35)", () => {
  expect(collectFingerprint(mkdtempSync(join(tmpdir(), "{{SECRET_5k34n5lr}}")))).toBeUndefined();
});

it("fingerprint unchanged → fresh", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A"); s.put(a);
  expect(verdictAt(a, s)).toBe("fresh");
});

it("changed during the exclusive period → stale (F64 prerequisite)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B" }); s.put(a);
  expect(verdictAt(a, s)).toBe("stale");
});

it("parallel jobs with the same task and same session do not count as interference (F56)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7, sessionId: "S" }); s.put(a);
  s.put(j("B", { taskId: 7, sessionId: "S", startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "B" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
  expect(verdictAt(a, s)).toBe("stale");
});

it("a writing job with the same taskId from another session is not wrongly excluded (§17.6)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { taskId: 1, sessionId: "SA", fpEnd: "B" }); s.put(a);
  s.put(j("B", { taskId: 1, sessionId: "SB", startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  expect(classifyOverlap(a, s).interferers).toEqual(["B"]);
  expect(verdictAt(a, s)).toBe("unknown");
});

it("fpStart===fpEnd during a concurrent job does not count as interference (F57)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7, sessionId: "S" }); s.put(a);
  s.put(j("B", { taskId: 8, sessionId: "S", startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "A" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
});

it("concurrent job with writes → unknown (F58)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7, sessionId: "S" }); s.put(a);
  s.put(j("B", { taskId: 8, sessionId: "S", startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  expect(classifyOverlap(a, s).interferers).toEqual(["B"]);
  expect(verdictAt(a, s)).toBe("unknown");
  expect(fpReason(a)).toContain("unattributable");
});

it("concurrent job missing fpEnd → interferers ⇒ unknown (F63/F75)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7, sessionId: "S" }); s.put(a);
  s.put(j("B", { taskId: 8, sessionId: "S", startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  expect(classifyOverlap(a, s).interferers).toEqual(["B"]);
  expect(verdictAt(a, s)).toBe("unknown");
});

it("writes and unfinished jobs together still yield unknown, not stale (F79)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7, sessionId: "S" }); s.put(a);
  s.put(j("B", { taskId: 8, sessionId: "S", startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  s.put(j("C", { taskId: 9, sessionId: "S", startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  expect(classifyOverlap(a, s).interferers.sort()).toEqual(["B", "C"]);
  expect(verdictAt(a, s)).toBe("unknown");
});

it("collection failure (missing fpStart/fpEnd) → unknown, not fresh (Review Focus 4)", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpStart: undefined, fpEnd: undefined }); s.put(a);
  expect(verdictAt(a, s)).toBe("unknown");
});
