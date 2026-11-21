import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyCleanup, markPurged, planCleanup, retentionCandidates } from "../../src/board/cleanup.js";
import { applyMutation } from "../../src/board/reducer.js";
import { emptyBoard, type BoardState, type Task } from "../../src/board/types.js";
import type { JobFacts, RuleContext } from "../../src/board/invariants.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

const facts = (running: number[] = [], backoff: number[] = []): JobFacts => ({
  hasRunning: (id) => running.includes(id), hasBackoff: (id) => backoff.includes(id),
  startedAt: () => 0, exists: () => true,
});
const ctx = (f = facts()): RuleContext => ({ wipLimit: 3, now: 1000, facts: f });
const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]): BoardState => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

it("默认 scope=settled：只清 completed 与 deleted，保留 pending/in_progress/parked", () => {
  const s = b([t(1, { status: "completed" }), t(2, { status: "deleted" }), t(3), t(4, { status: "in_progress" }),
               t(5, { status: "parked", park: { reason: "r", at: 1, from: "pending" } })]);
  const p = planCleanup(s, undefined, undefined, facts());
  expect(p.remove.sort()).toEqual([1, 2]);
  expect(applyCleanup(s, p, 1000).tasks.map((x) => x.id)).toEqual([3, 4, 5]);
});

it("scope=completed / deleted 各自只清一类", () => {
  const s = b([t(1, { status: "completed" }), t(2, { status: "deleted" })]);
  expect(planCleanup(s, "completed", undefined, facts()).remove).toEqual([1]);
  expect(planCleanup(s, "deleted", undefined, facts()).remove).toEqual([2]);
});

it("scope=all 无 force 被拒（R18）", () => {
  const s = b([t(1)]);
  expect(planCleanup(s, "all", undefined, facts()).error).toMatch(/force/);
});

it("scope=all + force 但有 running 作业被拒，文案指向 halt（R18）", () => {
  const s = b([t(1, { status: "in_progress" })]);
  const p = planCleanup(s, "all", true, facts([1]));
  expect(p.error).toMatch(/halt/);
});

it("scope=all + force 但有退避链被拒（R18）", () => {
  expect(planCleanup(b([t(1, { status: "in_progress" })]), "all", true, facts([], [1])).error).toMatch(/halt/);
});

it("任何 scope 下绑 running 作业的任务被跳过并列出（R18 部分成功）", () => {
  const s = b([t(1, { status: "completed", jobs: ["bg_a"] }), t(2, { status: "completed" })]);
  const p = planCleanup(s, "completed", undefined, facts([1]));
  expect(p.remove).toEqual([2]);
  expect(p.skipped).toEqual([1]);
});

it("clear 经 reducer 时默认不再全清（防回归）", () => {
  let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
  s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
  const r = applyMutation(s, { action: "clear" }, ctx());
  expect(r.state.tasks).toHaveLength(1);          // in_progress 不被默认清掉
});

it("clear scope=all force 在无作业时可全清", () => {
  const s = b([t(1), t(2, { status: "completed" })]);
  const r = applyMutation(s, { action: "clear", scope: "all", force: true }, ctx());
  expect(r.state.tasks).toHaveLength(0);
  expect(r.op.kind).toBe("clear");
});

it("清理保留 counters（不得重置 turnsUsed 绕过保险丝）", () => {
  const s = b([t(1, { status: "completed" })]);
  s.counters.turnsUsed = 42;
  const r = applyMutation(s, { action: "clear", scope: "all", force: true }, ctx());
  expect(r.state.counters.turnsUsed).toBe(42);
});

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, finalized: true,
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, notifyState: "pending", ...o,
});

it("markPurged 标记绑定链的 root（R19）", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_c1nsk0qv}}")));
  jobs.put(job("R"));
  const roots = markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })]);
  expect(roots).toEqual(["R"]);
  expect(jobs.get("R")?.purged).toBe(true);
});

it("retention 只候选 completed/deleted，绝不包含 parked", () => {
  const s = b([t(1, { status: "completed", statusSince: 10 }), t(2, { status: "deleted", statusSince: 10 }),
               t(3, { status: "parked", statusSince: 10, park: { reason: "r", at: 10, from: "pending" } }),
               t(4, { status: "completed", statusSince: 900 })]);
  expect(retentionCandidates(s, 100, 1000).sort()).toEqual([1, 2]);
});

it("retentionMs=0 关闭，不产生候选", () => {
  const s = b([t(1, { status: "completed", statusSince: 1 })]);
  expect(retentionCandidates(s, 0, 100_000)).toEqual([]);
});
