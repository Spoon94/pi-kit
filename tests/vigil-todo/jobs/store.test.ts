import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createJobStore, projectHash, runDir } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-jobs-"));
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("projectHash is stable and runDir lives under /tmp/bg-run", () => {
  expect(projectHash("/a/b")).toBe(projectHash("/a/b"));
  expect(projectHash("/a/b")).not.toBe(projectHash("/a/c"));
  expect(runDir("/a/b")).toBe(`/tmp/bg-run/${projectHash("/a/b")}`);
});

it("put/save/load round trip", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("bg_a")); s.save();
  const t = createJobStore(d);
  expect(t.load().degraded).toBe(false);
  expect(t.get("bg_a")?.id).toBe("bg_a");
});

it("corruption is archived and loading starts empty (F12)", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), "{broken");
  const s = createJobStore(d);
  const r = s.load();
  expect(r.degraded).toBe(true);
  expect(s.all()).toHaveLength(0);
  expect(readdirSync(d).some((f) => f.startsWith("jobs.json.corrupt-"))).toBe(true);
});

it("non-array jobs or an entry with missing fields counts as corruption (Review Focus 2)", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), JSON.stringify({ jobs: "x" }));
  expect(createJobStore(d).load().degraded).toBe(true);
  const d2 = dir(); writeFileSync(join(d2, "jobs.json"), JSON.stringify({ jobs: [{ id: "a" }] }));
  expect(createJobStore(d2).load().degraded).toBe(true);
});

it("GC clears only terminal jobs past TTL, never running ones, and returns the deletion count", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("old", { endedAt: 1 }));
  s.put(job("run", { status: "running", endedAt: null }));
  s.save();
  expect(s.gc(1000, 10_000)).toBe(1);
  expect(s.get("old")).toBeUndefined();
  expect(s.get("run")).toBeDefined();
});

it("B4 record cap: before TTL, reclaim the oldest complete chains; never delete unterminated/unacked chains", () => {
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

it("B4 cap does not clear running / backoff / unprojected chains", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("run", { status: "running", endedAt: null, finalized: false }));
  s.put(job("backoff", { retryAt: 1, finalized: false }));
  s.put(job("unprojected", { finalized: true, evidenceApplied: false, notifyState: "acked" }));
  expect(s.gc(1e15, 0, 1)).toBe(0);
  expect(s.all()).toHaveLength(3);
});

it("isSafeLogPath allows only paths inside runDir (MINOR #2)", () => {
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

it("isSafeLogPath rejects a symlink inside runDir that points outside (MINOR)", () => {
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
