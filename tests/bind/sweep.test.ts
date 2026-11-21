import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { catchUpScan, sweepAll, sweepDefers, sweepRespawns, type SweepDeps } from "../../src/bind/sweep.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let d: SweepDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_1u96oh3p}}")));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress", inProgressSince: 0 },
    { id: 2, subject: "b", status: "pending", defer: { untilRoot: "R", reason: "冲突", at: 1 } },
  ];
  b.nextId = 3; boards.commit("S", b);
  d = { boards, jobs, cfg: DEFAULTS, now: 1000, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
});

it("链未终结时 defer 不释放（F18）", () => {
  jobs.put(j("R", { status: "failed", retryAt: 5000 }));
  expect(sweepDefers(d)).toBe(0);
  expect(boards.get("S").tasks[1].defer).toBeDefined();
});

it("整链终结后释放 defer（F18）", () => {
  jobs.put(j("R", { attempt: 4 }));
  expect(sweepDefers(d)).toBe(1);
  expect(boards.get("S").tasks[1].defer).toBeUndefined();
});

it("untilRoot 无记录 → 释放 + notify（F34）", () => {
  let note = "";
  d.notify = (n) => { note = n; };
  expect(sweepDefers(d)).toBe(1);
  expect(note).toContain("R");
});

it("retryAt 到期即 respawn（F45）", () => {
  jobs.put(j("R", { retryAt: 500 }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("retryAt 未到期不 respawn", () => {
  jobs.put(j("R", { retryAt: 5000 }));
  expect(sweepRespawns(d)).toBe(0);
});

it("pendingReverify 且未终结 → 补一次 respawn（F85）", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, fpVerdict: "stale" }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("pendingReverify 额度已尽 → 判终结 parked，不悬置（F85）", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, attempt: 4 }));
  jobs.put(j("R2", { rootId: "R", retryOf: "R", staleReverifyOf: "R" }));
  d.respawn = () => ({ ok: false });
  sweepRespawns(d);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
});

it("catch-up 只扫 root 粒度：中间失败 job 不入扫描集（F89）", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  jobs.put(j("M", { rootId: "R", attempt: 2, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("acked 永不补发（F8）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "acked" }));
  expect(catchUpScan(d)).toEqual([]);
});

it("sent 未超 10min 不补发", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 900 }));
  expect(catchUpScan(d)).toEqual([]);
});

it("非 idle 时跳过 sent 补发（F80）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  expect(catchUpScan({ ...d, isIdle: () => false })).toEqual([]);
});

it("未投影的 finalized 链优先入扫描集（F84）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: false, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("sweepAll 汇总三项", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const r = sweepAll(d);
  expect(r.defersReleased).toBe(1);
  expect(r.respawned).toBe(0);
  expect(r.catchUp).toEqual([]);
});
