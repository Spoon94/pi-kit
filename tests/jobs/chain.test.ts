import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canRetry, canReverify, chainJobs, chainTerminated, isReverifyBranch, nextAttempt, retryDelayMs, terminalJob } from "../../src/jobs/chain.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-chain-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("退避间隔按 attempt 取，越界取最后一档", () => {
  const d = [0, 30_000, 120_000];
  expect(retryDelayMs(1, d)).toBe(0);
  expect(retryDelayMs(2, d)).toBe(30_000);
  expect(retryDelayMs(3, d)).toBe(120_000);
  expect(retryDelayMs(9, d)).toBe(120_000);
});

it("attempt 上限含重验分支内的失败重试（F67）", () => {
  const s = store();
  s.put(j("a1", { attempt: 1 }));
  s.put(j("r1", { attempt: 1, retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  s.put(j("r2", { attempt: 2, retryOf: "r1", status: "failed" }));
  s.put(j("r3", { attempt: 3, retryOf: "r2", status: "failed" }));
  s.put(j("r4", { attempt: 4, retryOf: "r3", status: "failed" }));
  expect(canRetry(s.get("r4")!, s, 3)).toBe(false);
  expect(chainJobs(s, "R")).toHaveLength(5);
});

it("重验分支后代不得再触发重验（F67）", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  s.put(j("r1", { retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  s.put(j("r2", { attempt: 2, retryOf: "r1", status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(isReverifyBranch(s.get("r2")!, s)).toBe(true);
  expect(canReverify(s.get("r2")!, s, 1)).toBe(false);
  expect(canReverify(s.get("a1")!, s, 1)).toBe(false);   // 额度已用
});

it("首次 stale 且额度未用可重验（F64）", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(canReverify(s.get("a1")!, s, 1)).toBe(true);
});

it("重验只为「重验 + 一次失败重试」留槽：4 job 链不再重验（BLOCKER）", () => {
  const s = store();
  for (let i = 1; i <= 4; i++) {
    s.put(j(`a${i}`, { id: `a${i}`, rootId: "R", retryOf: i > 1 ? `a${i - 1}` : undefined,
      attempt: i, status: i === 4 ? "completed" : "failed", exitCode: i === 4 ? 0 : 1 }));
  }
  expect(canReverify(s.get("a4")!, s, 1, 3)).toBe(false);

  const s3 = store();
  for (let i = 1; i <= 3; i++) {
    s3.put(j(`a${i}`, { id: `a${i}`, rootId: "R", retryOf: i > 1 ? `a${i - 1}` : undefined,
      attempt: i, status: i === 3 ? "completed" : "failed", exitCode: i === 3 ? 0 : 1 }));
  }
  expect(canReverify(s3.get("a3")!, s3, 1, 3)).toBe(true);
});

it("chainTerminated 是派生判定：running / retryAt / pendingReverify 任一存在即未终结", () => {
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

it("root 记录不存在时视为已终结（F34 孤儿）", () => {
  expect(chainTerminated(store(), "missing")).toBe(true);
});

it("terminalJob 按写入顺序取最后一条，不依赖 endedAt（MAJOR #4）", () => {
  const s = store();
  s.put(j("R", { endedAt: 2 }));
  s.put(j("R2", { rootId: "R", retryOf: "R", endedAt: 2 }));
  expect(terminalJob(s, "R")?.id).toBe("R2");
  expect(nextAttempt(s.get("R2")!)).toBe(2);
});
