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

it("default scope=settled: clears only completed and deleted, keeps pending/in_progress/parked", () => {
  const s = b([t(1, { status: "completed" }), t(2, { status: "deleted" }), t(3), t(4, { status: "in_progress" }),
               t(5, { status: "parked", park: { reason: "r", at: 1, from: "pending" } })]);
  const p = planCleanup(s, undefined, undefined, facts());
  expect(p.remove.sort()).toEqual([1, 2]);
  expect(applyCleanup(s, p, 1000).tasks.map((x) => x.id)).toEqual([3, 4, 5]);
});

it("scope=completed / deleted each clears only its own class", () => {
  const s = b([t(1, { status: "completed" }), t(2, { status: "deleted" })]);
  expect(planCleanup(s, "completed", undefined, facts()).remove).toEqual([1]);
  expect(planCleanup(s, "deleted", undefined, facts()).remove).toEqual([2]);
});

it("scope=all without force is rejected (R18)", () => {
  const s = b([t(1)]);
  expect(planCleanup(s, "all", undefined, facts()).error).toMatch(/force/);
});

it("scope=all + force with a running job is rejected; message points to halt (R18)", () => {
  const s = b([t(1, { status: "in_progress" })]);
  const p = planCleanup(s, "all", true, facts([1]));
  expect(p.error).toMatch(/halt/);
});

it("scope=all + force with a backoff chain is rejected (R18)", () => {
  expect(planCleanup(b([t(1, { status: "in_progress" })]), "all", true, facts([], [1])).error).toMatch(/halt/);
});

it("under any scope, tasks bound to a running job are skipped and listed (R18 partial success)", () => {
  const s = b([t(1, { status: "completed", jobs: ["bg_a"] }), t(2, { status: "completed" })]);
  const p = planCleanup(s, "completed", undefined, facts([1]));
  expect(p.remove).toEqual([2]);
  expect(p.skipped).toEqual([1]);
});

it("clear through the reducer no longer clears everything by default (regression guard)", () => {
  let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
  s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
  const r = applyMutation(s, { action: "clear" }, ctx());
  expect(r.state.tasks).toHaveLength(1);          // in_progress is not cleared by default
});

it("clear scope=all force clears everything when there are no jobs", () => {
  const s = b([t(1), t(2, { status: "completed" })]);
  const r = applyMutation(s, { action: "clear", scope: "all", force: true }, ctx());
  expect(r.state.tasks).toHaveLength(0);
  expect(r.op.kind).toBe("clear");
});

it("cleanup preserves counters (must not reset turnsUsed to bypass the fuse)", () => {
  const s = b([t(1, { status: "completed" })]);
  s.counters.turnsUsed = 42;
  const r = applyMutation(s, { action: "clear", scope: "all", force: true }, ctx());
  expect(r.state.counters.turnsUsed).toBe(42);
});

it("cleanup removes blockedBy references to completed dependencies; downstream can advance (BLOCKER)", () => {
  const s = b([t(1, { status: "completed" }), t(2, { blockedBy: [1] })]);
  const cleared = applyMutation(s, { action: "clear" }, ctx());
  expect(cleared.state.tasks.map((x) => x.id)).toEqual([2]);
  expect(cleared.state.tasks[0].blockedBy).toBeUndefined();
  const advanced = applyMutation(cleared.state, { action: "update", id: 2, status: "in_progress" }, ctx());
  expect(advanced.op.kind).toBe("update");
});

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, finalized: true,
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, notifyState: "pending", ...o,
});

it("markPurged marks the root of bound chains (R19)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_c1nsk0qv}}")));
  jobs.put(job("R"));
  const roots = markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })]);
  expect(roots).toEqual(["R"]);
  expect(jobs.get("R")?.purged).toBe(true);
});

it("markPurged cancels both backoff and pending reverify (BLOCKER)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_c1nsk0qv}}")));
  jobs.put(job("R", { retryAt: 500, pendingReverify: true }));
  markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })]);
  expect(jobs.get("R")?.purged).toBe(true);
  expect(jobs.get("R")?.retryAt).toBeUndefined();
  expect(jobs.get("R")?.pendingReverify).toBeFalsy();
});

it("markPurged clears backoff/pending reverify for every job in the chain (MAJOR #2)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_c1nsk0qv}}")));
  jobs.put(job("R", { retryAt: 500, pendingReverify: true }));
  jobs.put(job("R2", { rootId: "R", retryOf: "R", retryAt: 600, pendingReverify: true }));
  markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })]);
  for (const id of ["R", "R2"]) {
    expect(jobs.get(id)?.purged).toBe(true);
    expect(jobs.get(id)?.retryAt).toBeUndefined();
    expect(jobs.get(id)?.pendingReverify).toBeFalsy();
  }
});

it("F123 markPurged is idempotent: no write when nothing changes (P2)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_c1nsk0qv}}")));
  jobs.put(job("R"));
  markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })]);
  let saves = 0;
  const save = jobs.save.bind(jobs);
  jobs.save = () => { saves++; save(); };
  expect(markPurged(jobs, [1], [t(1, { status: "completed", jobs: ["R"] })])).toEqual(["R"]);
  expect(saves).toBe(0);
});

it("retention candidates include only completed/deleted, never parked", () => {
  const s = b([t(1, { status: "completed", statusSince: 10 }), t(2, { status: "deleted", statusSince: 10 }),
               t(3, { status: "parked", statusSince: 10, park: { reason: "r", at: 10, from: "pending" } }),
               t(4, { status: "completed", statusSince: 900 })]);
  expect(retentionCandidates(s, 100, 1000).sort()).toEqual([1, 2]);
});

it("retentionMs=0 disables retention and produces no candidates", () => {
  const s = b([t(1, { status: "completed", statusSince: 1 })]);
  expect(retentionCandidates(s, 0, 100_000)).toEqual([]);
});

it("missing or 0 statusSince is treated as ancient; retention may clear it (MAJOR)", () => {
  const s = b([t(1, { status: "completed", statusSince: 0 }), t(2, { status: "deleted" })]);
  expect(retentionCandidates(s, 1000, 100_000).sort()).toEqual([1, 2]);
});
