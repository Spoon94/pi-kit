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

it("retryAt due immediately respawns (F45)", () => {
  jobs.put(j("R", { retryAt: 500 }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("retryAt not due does not respawn", () => {
  jobs.put(j("R", { retryAt: 5000 }));
  expect(sweepRespawns(d)).toBe(0);
});

it("pendingReverify without termination triggers one respawn (F85)", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, fpVerdict: "stale" }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("pendingReverify quota exhausted → terminal parked, not left pending (F85)", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, attempt: 6 }));
  jobs.put(j("R2", { rootId: "R", retryOf: "R", staleReverifyOf: "R" }));
  d.respawn = () => ({ ok: false });
  sweepRespawns(d);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
});

it("F85 recovered reverify inherits the chain max attempt and stays within 7 jobs", () => {
  jobs.put(j("R", { attempt: 1, status: "completed", exitCode: 0, pendingReverify: true, fpVerdict: "stale" }));
  for (let i = 2; i <= 5; i++) {
    jobs.put(j(`R${i}`, { rootId: "R", retryOf: i === 2 ? "R" : `R${i - 1}`,
      attempt: i, status: "failed", exitCode: 1 }));
  }
  let req: { attempt?: number; staleReverifyOf?: string } | undefined;
  d.respawn = (r) => { req = r; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(req?.attempt).toBe(5);                 // not root.attempt=1
  expect(req?.staleReverifyOf).toBe("R");
  expect(jobs.get("R")?.pendingReverify).toBe(false);
});

it("catch-up scans root granularity only: intermediate failed jobs are not in the scan set (F89)", () => {
  jobs.put(j("R", { attempt: 6, finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  jobs.put(j("M", { rootId: "R", attempt: 2, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("acked is never redelivered (F8)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "acked" }));
  expect(catchUpScan(d)).toEqual([]);
});

it("sent under 10min is not redelivered", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 900 }));
  expect(catchUpScan(d)).toEqual([]);
});

it("non-idle skips sent redelivery (F80)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  expect(catchUpScan({ ...d, isIdle: () => false })).toEqual([]);
});

it("unprojected finalized chains enter the scan set first (F84)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: false, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("sweepAll summarizes respawn / catch-up / retention", () => {
  jobs.put(j("R", { attempt: 6, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const r = sweepAll(d);
  expect(r.respawned).toBe(0);
  expect(r.catchUp).toEqual([]);
  expect(r.retained).toBe(0);
});

it("purged chains are never redelivered (R19)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "pending", purged: true }));
  expect(catchUpScan(d)).toEqual([]);
});

it("trigger:self terminations are not redelivered (F81)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "pending",
    finalResult: { ok: false, note: "killed", trigger: "self", at: 2 } }));
  expect(catchUpScan(d)).toEqual([]);
});

it("purged chains are not respawned (BLOCKER)", () => {
  jobs.put(j("R", { retryAt: 100, purged: true }));
  let calls = 0;
  d.respawn = () => { calls++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(0);
  expect(calls).toBe(0);
});

it("F117 sweepAll retention clears old, keeps new, and purges", () => {
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

it("F118 reverify respawn failure → task parked with no free slot for reverify", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, taskId: 1 }));
  d.respawn = () => ({ ok: false });
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
  const task = boards.get("S").tasks[0];
  expect(task.status).toBe("parked");
  expect(task.park?.reason).toContain("no free slot for reverify");
});

it("respawn error → no retry, clear backoff, task parked(spawn failed) (F32)", () => {
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

it("F123 idle sweepAll writes zero times (P1 perf regression)", () => {
  jobs.put(j("R", { attempt: 6, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const saves = countSaves(jobs);
  expect(sweepAll(d)).toEqual({ respawned: 0, catchUp: [], retained: 0, boardDirty: false });
  expect(saves()).toBe(0);
});

it("A1 respawn failure that parks a task reports boardDirty", () => {
  jobs.put(j("R", { retryAt: 500 }));
  d.respawn = () => ({ ok: false });
  const r = sweepAll(d);
  expect(r.respawned).toBe(0);
  expect(r.boardDirty).toBe(true);
  expect(boards.get("S").tasks[0].status).toBe("parked");
});

it("A1 respawn success changes only the sidecar and does not report boardDirty", () => {
  jobs.put(j("R", { retryAt: 500 }));
  expect(sweepAll(d).boardDirty).toBe(false);
});

it("F123 due respawn success writes exactly once (P1)", () => {
  jobs.put(j("R", { retryAt: 500 }));
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(1);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(saves()).toBe(1);
});

it("F123 the respawn failure path also writes only on change (P1)", () => {
  jobs.put(j("R", { retryAt: 500 }));
  d.respawn = () => ({ ok: false });
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(saves()).toBe(1);
});

it("F123 clearing a stuck pendingReverify counts as one change; a second scan writes nothing (P1)", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true }));
  jobs.put(j("R2", { rootId: "R", retryOf: "R", staleReverifyOf: "R" }));
  const saves = countSaves(jobs);
  expect(sweepRespawns(d)).toBe(0);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
  expect(saves()).toBe(1);
  expect(sweepRespawns(d)).toBe(0);
  expect(saves()).toBe(1);
});

it("after delivery failure, the single timer catches up after 10min (F76)", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 1000 }));
  expect(catchUpScan({ ...d, now: 1000 + DEFAULTS.notifyRetryMs + 1 })).toEqual(["R"]);
});
