import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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

it("GC 只清超 TTL 的终态作业，running 永不清，并返回删除数", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("old", { endedAt: 1 }));
  s.put(job("run", { status: "running", endedAt: null }));
  s.save();
  expect(s.gc(1000, 10_000)).toBe(1);
  expect(s.get("old")).toBeUndefined();
  expect(s.get("run")).toBeDefined();
});

it("B4 记录上限：TTL 未到时按最旧完整链回收，未终结/未 ack 的链绝不删", () => {
  const d = dir(); const s = createJobStore(d);
  for (let i = 0; i < 5; i++) {
    const done = job(`R${i}`, {
      endedAt: 10 + i, finalized: true, evidenceApplied: true, notifyState: "acked",
    });
    const child = job(`R${i}j2`, {
      rootId: `R${i}`, endedAt: 10 + i, status: "failed",
    });
    s.put(done); s.put(child);
  }
  s.put(job("pending", { finalized: true, evidenceApplied: true, notifyState: "pending" }));
  expect(s.gc(1e15, 0, 5)).toBe(6);
  expect(s.all().map((j) => j.id).sort()).toEqual(["R3", "R3j2", "R4", "R4j2", "pending"]);
});

it("B4 上限不清 running / 退避 / 未投影的链", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("run", { status: "running", endedAt: null, finalized: false }));
  s.put(job("backoff", { retryAt: 1, finalized: false }));
  s.put(job("unprojected", { finalized: true, evidenceApplied: false, notifyState: "acked" }));
  expect(s.gc(1e15, 0, 1)).toBe(0);
  expect(s.all()).toHaveLength(3);
});

it("isSafeLogPath 只允许 runDir 内路径（MINOR #2）", () => {
  const d = dir(); const s = createJobStore(d);
  writeFileSync(join(d, "a.log"), "x");
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "a.log"), "x");
  expect(s.isSafeLogPath(join(d, "a.log"))).toBe(true);
  expect(s.isSafeLogPath(join(d, "sub", "a.log"))).toBe(true);
  expect(s.isSafeLogPath("/etc/passwd")).toBe(false);
  expect(s.isSafeLogPath(join(d))).toBe(false);
  expect(s.isSafeLogPath(join(d, "..", "escape.log"))).toBe(false);
  expect(s.isSafeLogPath(join(d, "missing.log"))).toBe(false);
  expect(s.isSafeLogPath("")).toBe(false);
});

it("isSafeLogPath 拒绝 runDir 内指向外部的 symlink（MINOR）", () => {
  const root = dir();
  const d = join(root, "run");
  mkdirSync(d);
  const outside = join(root, "secret.txt");
  writeFileSync(outside, "SECRET-CONTENT");
  const link = join(d, "link.log");
  symlinkSync(outside, link);
  const normal = join(d, "normal.log");
  writeFileSync(normal, "ok");
  const s = createJobStore(d);
  expect(s.isSafeLogPath(normal)).toBe(true);
  expect(s.isSafeLogPath(link)).toBe(false);
  expect(s.isSafeLogPath(join(d, "missing.log"))).toBe(false);
});
