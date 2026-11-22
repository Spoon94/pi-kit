import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canRetry, canReverify, chainJobs, chainTerminated, isReverifyBranch, nextAttempt, retryDelayMs, terminalJob } from "../../../src/vigil-todo/jobs/chain.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-chain-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("backoff delay picks one of five tiers by attempt; out-of-range uses the last tier (tiers 4/5 are 5min/10min)", () => {
  const d = DEFAULTS.retryDelaysMs;
  expect(d).toEqual([0, 30_000, 120_000, 300_000, 600_000]);
  expect(retryDelayMs(1, d)).toBe(0);
  expect(retryDelayMs(2, d)).toBe(30_000);
  expect(retryDelayMs(3, d)).toBe(120_000);
  expect(retryDelayMs(4, d)).toBe(300_000);
  expect(retryDelayMs(5, d)).toBe(600_000);
  expect(retryDelayMs(9, d)).toBe(600_000);
});

it("attempt limit includes failure retries inside the reverify branch (F67): still retryable at the 5th, stops at the 6th", () => {
  const s = store();
  s.put(j("a1", { attempt: 1 }));
  s.put(j("r1", { attempt: 1, retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  for (let i = 2; i <= 6; i++) {
    s.put(j(`r${i}`, { attempt: i, retryOf: i === 2 ? "r1" : `r${i - 1}`, status: "failed" }));
  }
  expect(canRetry(s.get("r5")!, s, 5)).toBe(true);
  expect(canRetry(s.get("r6")!, s, 5)).toBe(false);
  expect(chainJobs(s, "R")).toHaveLength(7);
});

it("descendants of a reverify branch must not trigger another reverify (F67)", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  s.put(j("r1", { retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  s.put(j("r2", { attempt: 2, retryOf: "r1", status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(isReverifyBranch(s.get("r2")!, s)).toBe(true);
  expect(canReverify(s.get("r2")!, s, 1)).toBe(false);
  expect(canReverify(s.get("a1")!, s, 1)).toBe(false);   // quota already used
});

it("first stale with unused quota can reverify (F64)", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(canReverify(s.get("a1")!, s, 1)).toBe(true);
});

it("reverify reserves a slot only for reverify + one failure retry: a 6-job chain cannot reverify again (BLOCKER)", () => {
  const s = store();
  for (let i = 1; i <= 6; i++) {
    s.put(j(`a${i}`, { id: `a${i}`, rootId: "R", retryOf: i > 1 ? `a${i - 1}` : undefined,
      attempt: i, status: i === 6 ? "completed" : "failed", exitCode: i === 6 ? 0 : 1 }));
  }
  expect(canReverify(s.get("a6")!, s, 1, 5)).toBe(false);

  const s5 = store();
  for (let i = 1; i <= 5; i++) {
    s5.put(j(`a${i}`, { id: `a${i}`, rootId: "R", retryOf: i > 1 ? `a${i - 1}` : undefined,
      attempt: i, status: i === 5 ? "completed" : "failed", exitCode: i === 5 ? 0 : 1 }));
  }
  expect(canReverify(s5.get("a5")!, s5, 1, 5)).toBe(true);
});

it("chain upper bound is 7: normally 6 jobs; reverify at worst adds 1 fallback retry and still stays within 7", () => {
  expect(1 + DEFAULTS.retries + DEFAULTS.staleReverify).toBe(7);

  // Path A: success after 5 failures (stale) → reverify (attempt 5) → failure → fallback retry (attempt 6)
  const a = store();
  for (let i = 1; i <= 5; i++) {
    a.put(j(`a${i}`, { id: `a${i}`, rootId: "R", retryOf: i > 1 ? `a${i - 1}` : undefined,
      attempt: i, status: i === 5 ? "completed" : "failed", exitCode: i === 5 ? 0 : 1,
      fpVerdict: i === 5 ? "stale" : "fresh" }));
  }
  expect(canReverify(a.get("a5")!, a, 1, 5)).toBe(true);
  a.put(j("rv", { id: "rv", rootId: "R", attempt: 5, retryOf: "a5", staleReverifyOf: "a5", status: "failed" }));
  expect(chainJobs(a, "R")).toHaveLength(6);
  expect(canRetry(a.get("rv")!, a, 5)).toBe(true);
  a.put(j("rv2", { id: "rv2", rootId: "R", attempt: 6, retryOf: "rv", status: "failed" }));
  expect(chainJobs(a, "R")).toHaveLength(7);
  expect(canRetry(a.get("rv2")!, a, 5)).toBe(false);

  // Path B: success on the first try but stale → reverify (attempt 1) + retries up to attempt 6, still 7
  const b = store();
  b.put(j("b1", { id: "b1", rootId: "R", attempt: 1, status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(canReverify(b.get("b1")!, b, 1, 5)).toBe(true);
  b.put(j("rv", { id: "rv", rootId: "R", attempt: 1, retryOf: "b1", staleReverifyOf: "b1", status: "failed" }));
  for (let i = 2; i <= 6; i++) {
    b.put(j(`r${i}`, { id: `r${i}`, rootId: "R", attempt: i, retryOf: i === 2 ? "rv" : `r${i - 1}`, status: "failed" }));
  }
  expect(chainJobs(b, "R")).toHaveLength(7);
  expect(canRetry(b.get("r6")!, b, 5)).toBe(false);
});

it("degenerate inputs: empty backoff array yields 0; root record fallback; staleReverify=0 disables reverify", () => {
  expect(retryDelayMs(1, [])).toBe(0);
  const s = store();
  expect(terminalJob(s, "missing")).toBeUndefined();
  s.put(j("R", { rootId: "OTHER" }));               // id is R but is not the root of this chain
  expect(terminalJob(s, "R")?.id).toBe("R");
  expect(canReverify(s.get("R")!, s, 0, 5)).toBe(false);
});

it("chainTerminated is derived: not terminated while any of running / retryAt / pendingReverify exists", () => {
  const s = store();
  s.put(j("R", { status: "running", endedAt: null }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", retryAt: 999 }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", retryAt: undefined, pendingReverify: true }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", pendingReverify: false }));
  expect(chainTerminated(s, "R")).toBe(true);
});

it("missing root record is treated as terminated (F34 orphan)", () => {
  expect(chainTerminated(store(), "missing")).toBe(true);
});

it("terminalJob returns the last entry in write order, independent of endedAt (MAJOR #4)", () => {
  const s = store();
  s.put(j("R", { endedAt: 2 }));
  s.put(j("R2", { rootId: "R", retryOf: "R", endedAt: 2 }));
  expect(terminalJob(s, "R")?.id).toBe("R2");
  expect(nextAttempt(s.get("R2")!)).toBe(2);
});
