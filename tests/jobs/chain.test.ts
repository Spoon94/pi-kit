import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canRetry, canReverify, chainJobs, chainTerminated, isReverifyBranch, nextAttempt, retryDelayMs, terminalJob } from "../../src/jobs/chain.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import type { Job } from "../../src/jobs/types.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-chain-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("退避间隔按 attempt 取五档，越界取最后一档（第 4/5 档 5min/10min）", () => {
  const d = DEFAULTS.retryDelaysMs;
  expect(d).toEqual([0, 30_000, 120_000, 300_000, 600_000]);
  expect(retryDelayMs(1, d)).toBe(0);
  expect(retryDelayMs(2, d)).toBe(30_000);
  expect(retryDelayMs(3, d)).toBe(120_000);
  expect(retryDelayMs(4, d)).toBe(300_000);
  expect(retryDelayMs(5, d)).toBe(600_000);
  expect(retryDelayMs(9, d)).toBe(600_000);
});

it("attempt 上限含重验分支内的失败重试（F67）：第 5 次仍可重试，第 6 次停", () => {
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

it("重验只为「重验 + 一次失败重试」留槽：6 job 链不再重验（BLOCKER）", () => {
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

it("链上界 7：正常 6 job；重验最坏 +1 保底重试也不超过 7", () => {
  expect(1 + DEFAULTS.retries + DEFAULTS.staleReverify).toBe(7);

  // 路径 A：5 次失败后成功(stale) → 重验(attempt 5) → 失败 → 保底重试(attempt 6)
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

  // 路径 B：首战即成功但 stale → 重验(attempt 1) + 重试到 attempt 6，仍为 7
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

it("退化输入：空退避数组取 0；root 记录兜底；staleReverify=0 不重验", () => {
  expect(retryDelayMs(1, [])).toBe(0);
  const s = store();
  expect(terminalJob(s, "missing")).toBeUndefined();
  s.put(j("R", { rootId: "OTHER" }));               // id 叫 R 但不是本链 root
  expect(terminalJob(s, "R")?.id).toBe("R");
  expect(canReverify(s.get("R")!, s, 0, 5)).toBe(false);
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
