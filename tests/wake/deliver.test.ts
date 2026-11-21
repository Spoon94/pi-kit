import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { emptyBoard, type BoardState, type Evidence } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { markSent } from "../../src/wake/ack.js";
import { needsTimer, recoveryWake, settleSend, tryDeliver } from "../../src/wake/deliver.js";

let jobs: ReturnType<typeof createJobStore>;
let board: BoardState;
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "R", ...o,
});
const root = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "r", command: "true", logPath: "/tmp/r.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending", ...o,
});
const input = (over: Partial<Parameters<typeof tryDeliver>[0]> = {}) => ({
  board, jobs, cfg: DEFAULTS, now: 1000, trigger: "async" as const, modelAdvanced: true, capacityFull: false, ...over,
});

beforeEach(() => {
  jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9x3c6mqp}}")));
  board = emptyBoard();
  board.tasks = [
    { id: 1, subject: "a", status: "completed", inProgressSince: 0, jobs: ["R"], evidence: [ev()] },
    { id: 2, subject: "b", status: "pending" },
  ];
  board.nextId = 3;
  jobs.put(root());
});

it("有未投递 chainFinal → 投递并推进 watermark（F59）", () => {
  const r = tryDeliver(input());
  expect(r.kind).toBe("deliver");
  if (r.kind !== "deliver") return;
  expect(r.counters.wakeWatermark).toBe(500);
  expect(r.counters.turnsUsed).toBe(1);
  expect(r.counters.renudgeBudget).toBe(1);
  expect(r.roots).toEqual(["R"]);
});

it("同一证据第二次不再投递（F59/F7）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("tool 证据不进 undelivered（F44）", () => {
  board.tasks[0].evidence = [ev({ origin: "tool", kind: "command" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("per-job 非 chainFinal 证据不投递（F74/F87）", () => {
  board.tasks[0].evidence = [ev({ chainFinal: false }), ev({ chainFinal: false, at: 400 })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("trigger:self 不投递（F81）", () => {
  board.tasks[0].evidence = [ev({ trigger: "self" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("turnsUsed 达上限第一行硬停（F24/F43）", () => {
  board.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(tryDeliver(input()).kind).toBe("none");
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("模型无动作 + next 存在 → re-nudge 恰一次（F23）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  const b = tryDeliver(input({ trigger: "boundary", modelAdvanced: false }));
  expect(b.kind).toBe("deliver");
  if (b.kind !== "deliver") return;
  expect(b.renudge).toBe(true);
  expect(b.counters.renudgeBudget).toBe(0);
  board = { ...board, counters: b.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("模型已推进则不 re-nudge（F23）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("WIP 满时 next 为空且文案不写开干（F40）", () => {
  board.tasks[1].status = "in_progress";
  board.tasks.push({ id: 3, subject: "c", status: "in_progress" }, { id: 4, subject: "d", status: "in_progress" });
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.text).toContain("WIP 满");
  expect(r.text).not.toContain("开干");
});

it("多条 chainFinal 合并为一条（F38）", () => {
  board.tasks[0].evidence = [ev({ ref: "R" }), ev({ ref: "R2", at: 501 })];
  jobs.put(root({ id: "R2", rootId: "R2" }));
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.roots.sort()).toEqual(["R", "R2"]);
});

it("root 已 sent 后正常通道不重复投递（BLOCKER）", () => {
  markSent(jobs, ["R"], "w1", 100);
  expect(tryDeliver(input()).kind).toBe("none");
});

it("root 已 acked 后正常通道不重复投递", () => {
  markSent(jobs, ["R"], "w1", 100);
  const s = jobs;
  s.put({ ...s.get("R")!, notifyState: "acked" });
  expect(tryDeliver(input()).kind).toBe("none");
});

it("purged root 的证据不再投递", () => {
  jobs.put(root({ purged: true }));
  expect(tryDeliver(input()).kind).toBe("none");
});

it("timer 条件纳入未 ack 通知（F76）", () => {
  const b = emptyBoard();
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);   // beforeEach root finalized + pending
  jobs.put(root({ notifyState: "acked" }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ status: "running", endedAt: null }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);
  b.counters.halted = true;
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
});

it("self / purged / maxTurns 后不再养 timer（MAJOR #1）", () => {
  const b = emptyBoard();
  jobs.put(root({ finalResult: { ok: false, note: "killed", trigger: "self", at: 2 } }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ purged: true }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root());
  b.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ status: "running", endedAt: null }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);  // 内部重试仍需 timer
});

it("resume 恢复唤醒受预算约束且推进 next（BLOCKER）", () => {
  const r = recoveryWake(input());
  expect(r.kind).toBe("deliver");
  if (r.kind !== "deliver") return;
  expect(r.counters.turnsUsed).toBe(1);
  expect(r.counters.wakeWatermark).toBe(0);
  expect(r.text).toContain("next: #2");
  board.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(recoveryWake(input()).kind).toBe("none");
  board.counters.turnsUsed = 0;
  board.counters.halted = true;
  expect(recoveryWake(input()).kind).toBe("none");
});

it("settleSend 吞掉异步 rejection（BLOCKER）", async () => {
  let err: unknown;
  settleSend(Promise.reject(new Error("boom")), (e) => { err = e; });
  await new Promise((res) => setTimeout(res, 0));
  expect((err as Error).message).toBe("boom");
});
