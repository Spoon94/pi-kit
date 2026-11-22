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

it("undelivered chainFinal → deliver and advance watermark (F59)", () => {
  const r = tryDeliver(input());
  expect(r.kind).toBe("deliver");
  if (r.kind !== "deliver") return;
  expect(r.counters.wakeWatermark).toBe(500);
  expect(r.counters.turnsUsed).toBe(1);
  expect(r.counters.renudgeBudget).toBe(1);
  expect(r.roots).toEqual(["R"]);
});

it("the same evidence is not delivered a second time (F59/F7)", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  markSent(jobs, a.roots, a.wakeId, 100);        // production path: must write sent after delivering
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("clock skew: watermark above evidence at, but root was never delivered ⇒ still deliver (A3)", () => {
  board.counters.wakeWatermark = 5000;
  const r = tryDeliver(input());
  expect(r.kind).toBe("deliver");
  if (r.kind !== "deliver") return;
  expect(r.counters.wakeWatermark).toBe(500);    // watermark takes max and never regresses
  markSent(jobs, r.roots, r.wakeId, 100);
  board = { ...board, counters: r.counters };
  expect(tryDeliver(input()).kind).toBe("none");
});

it("unknown ref still bounded by watermark (conservative A3)", () => {
  board.counters.wakeWatermark = 5000;
  board.tasks[0].evidence = [ev({ ref: "GHOST", at: 400 })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("tool evidence does not enter undelivered (F44)", () => {
  board.tasks[0].evidence = [ev({ origin: "tool", kind: "command" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("per-job non-chainFinal evidence is not delivered (F74/F87)", () => {
  board.tasks[0].evidence = [ev({ chainFinal: false }), ev({ chainFinal: false, at: 400 })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("trigger:self does not deliver (F81)", () => {
  board.tasks[0].evidence = [ev({ trigger: "self" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("turnsUsed at limit hard-stops on the first line (F24/F43)", () => {
  board.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(tryDeliver(input()).kind).toBe("none");
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("no model action + next exists → re-nudge exactly once (F23)", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  markSent(jobs, a.roots, a.wakeId, 100);
  board = { ...board, counters: a.counters };
  const b = tryDeliver(input({ trigger: "boundary", modelAdvanced: false }));
  expect(b.kind).toBe("deliver");
  if (b.kind !== "deliver") return;
  expect(b.renudge).toBe(true);
  expect(b.counters.renudgeBudget).toBe(0);
  board = { ...board, counters: b.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("if the model advanced, do not re-nudge (F23)", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  markSent(jobs, a.roots, a.wakeId, 100);
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("when WIP is full, next is empty and the text does not say to start (F40)", () => {
  board.tasks[1].status = "in_progress";
  board.tasks.push({ id: 3, subject: "c", status: "in_progress" }, { id: 4, subject: "d", status: "in_progress" });
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.text).toContain("WIP full");
  expect(r.text).not.toContain("Start:");
});

it("multiple chainFinal entries merge into one (F38)", () => {
  board.tasks[0].evidence = [ev({ ref: "R" }), ev({ ref: "R2", at: 501 })];
  jobs.put(root({ id: "R2", rootId: "R2" }));
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.roots.sort()).toEqual(["R", "R2"]);
});

it("after root is sent, the normal path does not redeliver (BLOCKER)", () => {
  markSent(jobs, ["R"], "w1", 100);
  expect(tryDeliver(input()).kind).toBe("none");
});

it("after root is acked, the normal path does not redeliver", () => {
  markSent(jobs, ["R"], "w1", 100);
  const s = jobs;
  s.put({ ...s.get("R")!, notifyState: "acked" });
  expect(tryDeliver(input()).kind).toBe("none");
});

it("evidence for a purged root is no longer delivered", () => {
  jobs.put(root({ purged: true }));
  expect(tryDeliver(input()).kind).toBe("none");
});

it("timer condition includes unacked notifications (F76)", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "completed" }];
  b.nextId = 2;
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);   // beforeEach root finalized + pending + task exists
  jobs.put(root({ notifyState: "acked" }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ status: "running", endedAt: null }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);
  b.counters.halted = true;
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);   // halted, but running still needs liveness checks to exit
  jobs.put(root({ notifyState: "acked" }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);  // halted and no running ⇒ 0 timers
});

it("no timer is kept after self / purged / maxTurns (MAJOR #1)", () => {
  const b = emptyBoard();
  jobs.put(root({ finalResult: { ok: false, note: "killed", trigger: "self", at: 2 } }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ purged: true }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root());
  b.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(false);
  jobs.put(root({ status: "running", endedAt: null }));
  expect(needsTimer(b, jobs, DEFAULTS)).toBe(true);  // internal retry still needs a timer
});

it("resume recovery wake is budget-bound and advances next (BLOCKER)", () => {
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

it("settleSend swallows async rejections (BLOCKER)", async () => {
  let err: unknown;
  settleSend(Promise.reject(new Error("boom")), (e) => { err = e; });
  await new Promise((res) => setTimeout(res, 0));
  expect((err as Error).message).toBe("boom");
});
