import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { catchUpScan, sweepAll, sweepRespawns, type SweepDeps } from "../../src/bind/sweep.js";
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
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_1u96oh3p}}")));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress", inProgressSince: 0 }];
  b.nextId = 2; boards.commit("S", b);
  d = { boards, jobs, cfg: DEFAULTS, now: 1000, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
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

it("sweepAll 汇总 respawn / catch-up / retention", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const r = sweepAll(d);
  expect(r.respawned).toBe(0);
  expect(r.catchUp).toEqual([]);
  expect(r.retained).toBe(0);
});

it("purged 链不再补发（R19）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "pending", purged: true }));
  expect(catchUpScan(d)).toEqual([]);
});

it("trigger:self 的终结不补发（F81）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "pending",
    finalResult: { ok: false, note: "killed", trigger: "self", at: 2 } }));
  expect(catchUpScan(d)).toEqual([]);
});

it("purged 链不被 respawn（BLOCKER）", () => {
  jobs.put(j("R", { retryAt: 100, purged: true }));
  let calls = 0;
  d.respawn = () => { calls++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(0);
  expect(calls).toBe(0);
});

it("F117 sweepAll retention 清旧留新并 purged", () => {
  const b = boards.get("S");
  b.tasks = [
    { id: 1, subject: "old", status: "completed", statusSince: 1, jobs: ["R"] },
    { id: 2, subject: "new", status: "completed", statusSince: 99_000 },
    { id: 3, subject: "deleted", status: "deleted", statusSince: 1 },
  ];
  b.nextId = 4;
  boards.commit("S", b);
  jobs.put(j("R", { taskId: 1, status: "completed", exitCode: 0, endedAt: 2 }));
  const r = sweepAll({ ...d, cfg: { ...DEFAULTS, taskRetentionMs: 1000 }, now: 100_000 });
  expect(r.retained).toBe(2);
  expect(boards.get("S").tasks.map((t) => t.id)).toEqual([2]);
  expect(jobs.get("R")?.purged).toBe(true);
});

it("F118 重验 respawn 失败 ⇒ 任务 parked「无空闲槽位重验」", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, taskId: 1 }));
  d.respawn = () => ({ ok: false });
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
  const task = boards.get("S").tasks[0];
  expect(task.status).toBe("parked");
  expect(task.park?.reason).toContain("无空闲槽位重验");
});

it("respawn 抛错 → 不重试、清退避、任务 parked(spawn failed)（F32）", () => {
  jobs.put(j("R", { retryAt: 500 }));
  d.respawn = () => ({ ok: false });
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(boards.get("S").tasks[0].status).toBe("parked");
  expect(boards.get("S").tasks[0].park?.reason).toContain("spawn failed");
});

const countSaves = (store: ReturnType<typeof createJobStore>): (() => number) => {
  let n = 0;
  const save = store.save.bind(store);
  store.save = () => { n++; save(); };
  return () => n;
};

it("F123 空闲 sweepAll 零落盘（P1 性能回归）", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const saves = countSaves(jobs);
  expect(sweepAll(d)).toEqual({ respawned: 0, catchUp: [], retained: 0, boardDirty: false });
  expect(saves()).toBe(0);
});

it("A1 respawn 失败导致 parkTask 时上报 boardDirty", () => {
  jobs.put(j("R", { retryAt: 500 }));
  d.respawn = () => ({ ok: false });
  const r = sweepAll(d);
  expect(r.respawned).toBe(0);
  expect(r.boardDirty).toBe(true);
  expect(boards.get("S").tasks[0].status).toBe("parked");
});

it("A1 respawn 成功只改 sidecar，不上报 boardDirty", () => {
  jobs.put(j("R", { retryAt: 500 }));
  expect(sweepAll(d).boardDirty).toBe(false);
});

it("F123 到期 respawn 成功恰好落盘一次（P1）", () => {
  jobs.put(j("R", { retryAt: 500 }));
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(1);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(saves()).toBe(1);
});

it("F123 respawn 失败路径同样只在有变化时落盘（P1）", () => {
  jobs.put(j("R", { retryAt: 500 }));
  d.respawn = () => ({ ok: false });
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(saves()).toBe(1);
});

it("F123 清除悬置 pendingReverify 计为一次变化，二次扫描零落盘（P1）", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true }));
  jobs.put(j("R2", { rootId: "R", retryOf: "R", staleReverifyOf: "R" }));
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
  expect(saves()).toBe(1);
  expect(sweepRespawns(d)).toBe(0);
  expect(saves()).toBe(1);
});

it("投递失败后由单 timer 在 10min 后补偿送达（F76）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 1000 }));
  expect(catchUpScan({ ...d, now: 1000 + DEFAULTS.notifyRetryMs + 1 })).toEqual(["R"]);
});
