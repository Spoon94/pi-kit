import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { halt, isHalted, reapHaltedLeftovers, resume, type HaltDeps } from "../../src/bind/halt.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { replayBranch } from "../../src/board/replay.js";
import { selectNext } from "../../src/board/selectors.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { tryDeliver } from "../../src/wake/deliver.js";
import { catchUpScan, sweepRespawns } from "../../src/bind/sweep.js";

let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
let d: HaltDeps;
let killed: string[];
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "sleep 99", logPath: "/tmp/a.log", cwd: "/tmp", pid: 999_999,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_h2q7w9ae}}")));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "训练", status: "in_progress", inProgressSince: 0, jobs: ["A"] },
             { id: 2, subject: "别的", status: "pending" }];
  b.nextId = 3; boards.commit("S", b);
  killed = [];
  d = { boards, jobs, now: 1000, sessionId: "S", kill: (id) => { killed.push(id); }, notify: () => {} };
});

it("halt 置 halted 并落快照（跨重启保持）", () => {
  jobs.put(j("A"));
  halt(d);
  expect(isHalted(boards.get("S"))).toBe(true);
  const snap = { action: "update", params: {}, tasks: boards.get("S").tasks, nextId: 3, counters: boards.get("S").counters };
  expect(replayBranch([{ type: "custom", customType: "rpiv-todo-state", data: snap }]).counters.halted).toBe(true);
});

it("halt 杀本会话作业并清退避（全局取消）", () => {
  jobs.put(j("A")); jobs.put(j("B", { status: "failed", exitCode: 1, endedAt: 2, retryAt: 5000, taskId: 2 }));
  const r = halt(d);
  expect(killed.sort()).toEqual(["A", "B"]);
  expect(jobs.get("B")?.retryAt).toBeUndefined();
  expect(r.killed).toBe(2);
});

it("halt 不杀别的会话的作业（项目共享边界）", () => {
  jobs.put(j("A")); jobs.put(j("OTHER", { sessionId: "OTHER" }));
  halt(d);
  expect(killed).toEqual(["A"]);
});

it("受影响任务 parked 且不写 lastFailure", () => {
  jobs.put(j("A"));
  halt(d);
  const t = boards.get("S").tasks[0];
  expect(t.status).toBe("parked");
  expect(t.park?.reason).toContain("强制中断");
  expect(t.park?.by).toBe("halt");
  expect(t.lastFailure).toBeUndefined();
});

it("halt 幂等，重复调用只补杀残留", () => {
  jobs.put(j("A"));
  expect(halt(d).alreadyHalted).toBe(false);
  expect(halt(d).alreadyHalted).toBe(true);
});

it("halted 时 tryDeliver 第一行返回 none（早于 maxTurns）", () => {
  jobs.put(j("A", { status: "completed", exitCode: 0, exitCodeKnown: true, endedAt: 2, finalized: true, evidenceApplied: true }));
  const b = boards.get("S");
  b.tasks[0].evidence = [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "A" }];
  b.counters.turnsUsed = 0;
  boards.commit("S", b);
  halt(d);
  expect(tryDeliver({ board: boards.get("S"), jobs, cfg: DEFAULTS, now: 2000, trigger: "async", modelAdvanced: true, capacityFull: false }).kind).toBe("none");
});

it("halted 时 sweepRespawns 不 respawn（复活防护）", () => {
  jobs.put(j("A", { status: "failed", exitCode: 1, endedAt: 2, retryAt: 100 }));
  halt(d);
  let calls = 0;
  const sd = { boards, jobs, cfg: DEFAULTS, now: 2000, sessionId: "S", respawn: () => { calls++; return { ok: true }; }, notify: () => {}, isIdle: () => true };
  expect(sweepRespawns(sd)).toBe(0);
  expect(calls).toBe(0);
});

it("halted 时 catchUpScan 为空（复活防护）", () => {
  jobs.put(j("A", { status: "completed", exitCode: 0, endedAt: 2, finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  halt(d);
  expect(catchUpScan({ boards, jobs, cfg: DEFAULTS, now: 900_000, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true })).toEqual([]);
});

it("resume 解除 halted 但不重置 turnsUsed（不得绕过保险丝）", () => {
  const b = boards.get("S"); b.counters.turnsUsed = 49; boards.commit("S", b);
  halt(d);
  expect(resume(d)).toBe(true);
  expect(isHalted(boards.get("S"))).toBe(false);
  expect(boards.get("S").counters.turnsUsed).toBe(49);
});

it("未 halted 时 resume 返回 false", () => {
  expect(resume(d)).toBe(false);
});

it("resume 把 halt parked 恢复为 pending，模型 park 的任务不动", () => {
  jobs.put(j("A"));
  const b = boards.get("S");
  b.tasks[1] = {
    id: 2, subject: "模型决定", status: "parked",
    park: { reason: "需要人拍板", at: 5, from: "pending" },
  };
  b.tasks[0] = { ...b.tasks[0], inProgressSince: 0 };
  boards.commit("S", b);

  halt(d);
  expect(boards.get("S").tasks[0].park?.by).toBe("halt");
  let note = "";
  d.notify = (n) => { note = n; };
  expect(resume(d)).toBe(true);
  const tasks = boards.get("S").tasks;
  expect(tasks[0].status).toBe("pending");
  expect(tasks[0].park).toBeUndefined();
  expect(tasks[0].inProgressSince).toBeUndefined();
  expect(tasks[0].statusSince).toBe(1000);
  expect(tasks[1].status).toBe("parked");
  expect(tasks[1].park?.reason).toBe("需要人拍板");
  expect(note).toContain("1 个中断任务回到 pending");
});

it("多个 halt 任务全回 pending；resume 幂等；WIP 仍受约束；halt 快照可重放", () => {
  const b = boards.get("S");
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress", inProgressSince: 0, jobs: ["A"] },
    { id: 2, subject: "b", status: "in_progress", inProgressSince: 0, jobs: ["B"] },
  ];
  boards.commit("S", b);
  jobs.put(j("A"));
  jobs.put(j("B", { taskId: 2 }));

  halt(d);
  expect(boards.get("S").tasks.every((t) => t.status === "parked")).toBe(true);
  const haltedSnapshot = {
    action: "update", params: {},
    tasks: boards.get("S").tasks, nextId: 3, counters: boards.get("S").counters,
  };
  const replayed = replayBranch([{ type: "custom", customType: "rpiv-todo-state", data: haltedSnapshot }]);
  expect(replayed.tasks.every((t) => t.status === "parked")).toBe(true);

  expect(resume(d)).toBe(true);
  const after = boards.get("S");
  expect(after.tasks.every((t) => t.status === "pending")).toBe(true);
  expect(after.tasks.filter((t) => t.status === "in_progress")).toHaveLength(0);
  expect(after.tasks.every((t) => t.park === undefined)).toBe(true);
  expect(after.counters.halted).toBeUndefined();
  expect(selectNext(after, 1, false)?.id).toBe(1);      // 一次只交回一个 next，WIP 不被突破

  expect(resume(d)).toBe(false);                        // 幂等
  expect(boards.get("S").tasks.every((t) => t.status === "pending")).toBe(true);
});

it("resume 达轮数上限时文案说明不会推进（MINOR）", () => {
  const b = boards.get("S");
  b.counters.turnsUsed = DEFAULTS.maxTurns;
  boards.commit("S", b);
  let note = "";
  d.notify = (n) => { note = n; };
  halt(d);
  expect(resume(d)).toBe(true);
  expect(note).toContain("达轮数上限");
  expect(note).toContain("发任意消息归零");
});

it("halt 后崩溃残留作业由启动 sweep 补杀", () => {
  jobs.put(j("A"));
  halt(d);
  killed.length = 0;
  jobs.put(j("A"));                       // 模拟崩溃后 sidecar 仍是 running
  expect(reapHaltedLeftovers(d)).toBe(1);
  expect(killed).toEqual(["A"]);
});
