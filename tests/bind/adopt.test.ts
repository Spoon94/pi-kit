import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { adoptOrphans, adoptableRoots, freezeMovedAway, importTasks, type AdoptDeps } from "../../src/bind/adopt.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard, type BoardState } from "../../src/board/types.js";
import { writeHeartbeat } from "../../src/jobs/heartbeat.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let d: AdoptDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
let dir: string;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "OLD", evidenceApplied: false, finalized: true,
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, notifyState: "pending", ...o,
});
const oldBoard = (): BoardState => {
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "回归", status: "in_progress", inProgressSince: 0, jobs: ["R"] },
    { id: 2, subject: "文档", status: "pending", blockedBy: [1] },
    { id: 3, subject: "已完成依赖", status: "completed" },
  ];
  b.nextId = 4;
  return b;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "{{SECRET_3x0m6r5p}}"));
  boards = createBoardStore(); jobs = createJobStore(dir);
  boards.commit("NEW", emptyBoard());
  d = { boards, jobs, cfg: DEFAULTS, now: 100_000, sessionId: "NEW", dir,
        readOldBoard: () => oldBoard(), notify: () => {} };
});

it("owner 不活跃 + finalized + 未投影 ⇒ 可收养（F88）", () => {
  jobs.put(j("R"));
  expect(adoptableRoots(d)).toEqual(["R"]);
});

it("running 链不收养（F92/F104）", () => {
  jobs.put(j("R", { status: "running", endedAt: null, finalized: false }));
  expect(adoptableRoots(d)).toEqual([]);
  expect(adoptableRoots({ ...d, manual: true })).toEqual([]);
});

it("owner 心跳新鲜 ⇒ 不收养（F96）", () => {
  jobs.put(j("R"));
  writeHeartbeat(dir, "OLD", process.pid, d.now);
  expect(adoptableRoots(d)).toEqual([]);
});

it("suspect 时人工 adopt 绕过 gate（F98）", () => {
  jobs.put(j("R"));
  writeHeartbeat(dir, "OLD", process.pid, 0);
  expect(adoptableRoots(d)).toEqual([]);
  expect(adoptableRoots({ ...d, manual: true })).toEqual(["R"]);
});

it("导入即重编号，不撞号（F93）", () => {
  const cur = emptyBoard();
  cur.tasks = [{ id: 1, subject: "新会话已有", status: "pending" }];
  cur.nextId = 2;
  const r = importTasks(oldBoard(), [1, 2], cur, "OLD");
  expect(r.board.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
  expect(r.board.tasks[1].metadata?.adoptedFrom).toEqual({ session: "OLD", id: 1 });
  expect(r.board.tasks[2].blockedBy).toEqual([2]);
});

it("旧 board 已 completed 的悬空依赖被删除（F100）", () => {
  const ob = oldBoard();
  ob.tasks[1].blockedBy = [3];
  const r = importTasks(ob, [2], emptyBoard(), "OLD");
  expect(r.board.tasks[0].blockedBy).toBeUndefined();
  expect(r.board.tasks[0].metadata?.resolvedDeps).toEqual([3]);
});

it("非终态悬空依赖保留（F100）", () => {
  const ob = oldBoard();
  ob.tasks[1].blockedBy = [1];
  const r = importTasks(ob, [2], emptyBoard(), "OLD");
  expect(r.board.tasks[0].blockedBy).toEqual([1]);
});

it("多链绑同一任务只导入一次（F93）", () => {
  jobs.put(j("R")); jobs.put(j("R2", { taskId: 1 }));
  const r = adoptOrphans(d);
  expect(r.imported).toBe(1);
});

it("收养后移交 sessionId 并投影（F88）", () => {
  jobs.put(j("R"));
  const r = adoptOrphans(d);
  expect(r.adopted).toEqual(["R"]);
  expect(jobs.get("R")?.sessionId).toBe("NEW");
  expect(boards.get("NEW").tasks.some((t) => (t.evidence ?? []).some((e) => e.chainFinal))).toBe(true);
});

it("两会话竞争只有一个收养者（F94/F101）", () => {
  jobs.put(j("R"));
  const a = adoptOrphans(d);
  const b = adoptOrphans({ ...d, sessionId: "NEW2", boards });
  expect(a.adopted.length + b.adopted.length).toBe(1);
});

it("旧会话重开时冻结已移交任务（F95/F97）", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "回归", status: "in_progress", jobs: ["R"] }];
  boards.commit("OLD", b);
  jobs.put(j("R", { sessionId: "NEW" }));
  writeHeartbeat(dir, "NEW", process.pid, d.now);
  expect(freezeMovedAway({ ...d, sessionId: "OLD" })).toBe(1);
  expect(boards.get("OLD").tasks[0].metadata?.adoptedAway).toEqual({ session: "NEW" });
});
