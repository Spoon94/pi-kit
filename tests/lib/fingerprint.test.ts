import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyOverlap, collectFingerprint, fpReason, verdictAt } from "../../src/lib/fingerprint.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

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
  fpStart: "A", fpEnd: "A", fpVerdict: "unknown", interferers: [], overlapUnfinished: [],
  rootId: id, attempt: 1, evidenceApplied: false, notifyState: "pending", ...o,
});

it("git 目录可采集；改动后指纹变化", () => {
  const d = gitDir();
  const a = collectFingerprint(d);
  expect(a).toBeDefined();
  writeFileSync(join(d, "a.txt"), "b");
  expect(collectFingerprint(d)).not.toBe(a);
});

it("非 git 目录返回 undefined（F35）", () => {
  expect(collectFingerprint(mkdtempSync(join(tmpdir(), "{{SECRET_5k34n5lr}}")))).toBeUndefined();
});

it("指纹未变 → fresh", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A"); s.put(a);
  expect(verdictAt(a, s)).toBe("fresh");
});

it("独占期间变了 → stale（F64 前置）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B" }); s.put(a);
  expect(verdictAt(a, s)).toBe("stale");
});

it("同 taskId 的并行作业不算干扰（F56）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 7, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "B" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
  expect(verdictAt(a, s)).toBe("stale");
});

it("并发作业期间 fpStart===fpEnd 不算干扰（F57）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "A" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
});

it("有写入的并发作业 → unknown（F58）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  expect(classifyOverlap(a, s).interferers).toEqual(["B"]);
  expect(verdictAt(a, s)).toBe("unknown");
  expect(fpReason(a)).toContain("无法归因");
});

it("并发作业缺 fpEnd → overlapUnfinished ⇒ unknown（F63/F75）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  const c = classifyOverlap(a, s);
  expect(c.overlapUnfinished).toEqual(["B"]);
  expect(c.interferers).toEqual([]);
  expect(verdictAt(a, s)).toBe("unknown");
});

it("两类同时存在仍是 unknown，不误判 stale（F79）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  s.put(j("C", { taskId: 9, startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  expect(verdictAt(a, s)).toBe("unknown");
});

it("采集失败（fpStart/fpEnd 缺失）→ unknown，不当 fresh（Review Focus 4）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_7a5hk2xj}}")));
  const a = j("A", { fpStart: undefined, fpEnd: undefined }); s.put(a);
  expect(verdictAt(a, s)).toBe("unknown");
});
