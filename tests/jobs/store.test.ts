import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createJobStore, projectHash, runDir } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-jobs-"));
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("projectHash 稳定且 runDir 在 /tmp/bg-run 下", () => {
  expect(projectHash("/a/b")).toBe(projectHash("/a/b"));
  expect(projectHash("/a/b")).not.toBe(projectHash("/a/c"));
  expect(runDir("/a/b")).toBe(`/tmp/bg-run/${projectHash("/a/b")}`);
});

it("put/save/load 往返", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("bg_a")); s.save();
  const t = createJobStore(d);
  expect(t.load().degraded).toBe(false);
  expect(t.get("bg_a")?.id).toBe("bg_a");
});

it("损坏时留档并从空开始（F12）", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), "{broken");
  const s = createJobStore(d);
  const r = s.load();
  expect(r.degraded).toBe(true);
  expect(s.all()).toHaveLength(0);
  expect(readdirSync(d).some((f) => f.startsWith("jobs.json.corrupt-"))).toBe(true);
});

it("jobs 非数组或单条缺字段视为损坏（Review Focus 2）", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), JSON.stringify({ jobs: "x" }));
  expect(createJobStore(d).load().degraded).toBe(true);
  const d2 = dir(); writeFileSync(join(d2, "jobs.json"), JSON.stringify({ jobs: [{ id: "a" }] }));
  expect(createJobStore(d2).load().degraded).toBe(true);
});

it("GC 只清超 TTL 的终态作业，running 永不清", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("old", { endedAt: 1 }));
  s.put(job("run", { status: "running", endedAt: null }));
  s.save();
  s.gc(1000, 10_000);
  expect(s.get("old")).toBeUndefined();
  expect(s.get("run")).toBeDefined();
});
