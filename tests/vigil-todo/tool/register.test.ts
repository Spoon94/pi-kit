import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { jobFactsOf } from "../../../src/vigil-todo/jobs/facts.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { createBgKillTool, createBgRunTool, createTodoTool, detectToolConflict, preflight, type ToolDeps } from "../../../src/vigil-todo/tool/register.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import type { RuleContext } from "../../../src/vigil-todo/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 1, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("Conflict detected when the old package occupies the tool (F13)", () => {
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:@juicesharp/rpiv-todo" } }], "npm:pi-kit")).toBe(true);
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:pi-kit" } }], "npm:pi-kit")).toBe(false);
  expect(detectToolConflict([], "npm:pi-kit")).toBe(false);
  expect(detectToolConflict([{ name: "todo" }], "npm:pi-kit")).toBe(true);
});

it("L1 preflight blocks obvious violations and provides a message", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  const r = preflight({ toolName: "todo", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx());
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain("WIP full");
});

it("L1 skips nested calls (F15)", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  expect(preflight({ toolName: "todo", parentToolCallId: "p1", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx())).toBeUndefined();
});

it("L1 ignores other tools (F14)", () => {
  expect(preflight({ toolName: "read", input: { path: "a" } }, emptyBoard(), ctx())).toBeUndefined();
});

it("L1 handles only update + numeric id", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }];
  expect(preflight({ toolName: "todo", input: { action: "get", id: 1 } }, b, ctx())).toBeUndefined();
  expect(preflight({ toolName: "todo", input: { action: "update", id: "1" } }, b, ctx())).toBeUndefined();
});

it("Malformed input does not throw (Review Focus 1)", () => {
  expect(preflight({ toolName: "todo", input: null }, emptyBoard(), ctx())).toBeUndefined();
  expect(preflight({ toolName: "todo", input: { action: "update" } }, emptyBoard(), ctx())).toBeUndefined();
});

const toolDeps = (
  board: ReturnType<typeof emptyBoard>,
  over: Partial<ToolDeps> = {},
): ToolDeps => ({
  sessionId: () => "S", cwd: () => "/tmp", board: () => board, commit: () => {}, appendEntry: () => {},
  ruleCtx: ctx, jobs: createJobStore(mkdtempSync(join(tmpdir(), "vigil-reg-"))), cfg: DEFAULTS,
  spawn: () => ({ ok: true, jobId: "bg_x" }), kill: () => {},
  runVerify: async () => ({ ok: true, exitCode: 0 }), now: () => 1, ...over,
});

it("The same job cannot bind to two tasks (F30)", async () => {
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress", jobs: ["bg_x"] },
    { id: 2, subject: "b", status: "pending" },
  ];
  b.nextId = 3;
  const killed: string[] = [];
  const deps = toolDeps(b, {
    ruleCtx: () => ({ wipLimit: 3, now: 1,
      facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true } }),
    kill: (id) => { killed.push(id); },
  });
  const r = await createBgRunTool(deps).execute({ command: "true", task_id: 2 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("already bound");
  expect(killed).toEqual(["bg_x"]);
});

it("bg_run against pending with WIP full is rejected: no bind, no advance (F41)", async () => {
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress" },
    { id: 2, subject: "b", status: "pending" },
  ];
  b.nextId = 3;
  let spawned = 0;
  const deps = toolDeps(b, { spawn: () => { spawned++; return { ok: true, jobId: "bg_y" }; } });
  const r = await createBgRunTool(deps).execute({ command: "true", task_id: 2 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("WIP full");
  expect(spawned).toBe(0);
  expect(b.tasks[1].jobs).toBeUndefined();
  expect(b.tasks[1].status).toBe("pending");
});

it("Manual park during verify is not overwritten by an old snapshot (BLOCKER)", async () => {
  let board = emptyBoard();
  board.tasks = [{ id: 1, subject: "v", status: "in_progress", verify: { kind: "command", command: "true" } }];
  board.nextId = 2;
  let resolveVerify!: (r: { ok: boolean; exitCode: number | null }) => void;
  const deps = toolDeps(board, {
    board: () => board,
    commit: (s) => { board = s; },
    runVerify: () => new Promise((res) => { resolveVerify = res; }),
  });
  const pending = createTodoTool(deps).execute({ action: "verify", id: 1 });
  board = { ...board, tasks: [{ ...board.tasks[0], status: "parked", park: { reason: "manual", at: 5, from: "in_progress" } }] };
  resolveVerify({ ok: true, exitCode: 0 });
  const r = await pending;
  expect(r.isError).toBeUndefined();
  expect(board.tasks[0].status).toBe("parked");
  expect(board.tasks[0].park?.reason).toBe("manual");
  expect(board.tasks[0].evidence).toHaveLength(1);
});

it("Task deleted during verify is not revived (BLOCKER)", async () => {
  let board = emptyBoard();
  board.tasks = [{ id: 1, subject: "v", status: "in_progress", verify: { kind: "command", command: "true" } }];
  board.nextId = 2;
  let resolveVerify!: (r: { ok: boolean; exitCode: number | null }) => void;
  let commits = 0;
  const deps = toolDeps(board, {
    board: () => board,
    commit: (s) => { commits++; board = s; },
    runVerify: () => new Promise((res) => { resolveVerify = res; }),
  });
  const pending = createTodoTool(deps).execute({ action: "verify", id: 1 });
  board = { ...board, tasks: [] };
  resolveVerify({ ok: true, exitCode: 0 });
  const r = await pending;
  expect(r.isError).toBe(true);
  expect(board.tasks).toHaveLength(0);
  expect(commits).toBe(0);
});

it("verify without an execution context returns isError and records untrusted evidence (§6.4)", async () => {
  let board = emptyBoard();
  board.tasks = [{ id: 1, subject: "v", status: "in_progress", verify: { kind: "command", command: "true" } }];
  board.nextId = 2;
  const deps = toolDeps(board, {
    board: () => board,
    commit: (s) => { board = s; },
    runVerify: async () => ({ ok: false, exitCode: null }),
  });
  const r = await createTodoTool(deps).execute({ action: "verify", id: 1 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("Verify command could not run");
  expect(board.tasks[0].evidence?.at(-1)).toMatchObject({ ok: false, known: false });
});

it("bg_run spawn failure returns isError and leaves state unchanged", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const deps = toolDeps(b, { spawn: () => ({ ok: false, error: "boom" }) });
  const r = await createBgRunTool(deps).execute({ command: "true", task_id: 1 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("boom");
  expect(b.tasks[0].status).toBe("pending");
});

it("bg_kill with unknown id returns isError", async () => {
  const b = emptyBoard();
  const r = await createBgKillTool(toolDeps(b)).execute({ job_id: "nope" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("not found");
});

it("clear via tool: deletes completed, markPurged, appendEntry", async () => {
  let board = emptyBoard();
  board.tasks = [
    { id: 1, subject: "done", status: "completed", jobs: ["R"] },
    { id: 2, subject: "keep", status: "pending" },
  ];
  board.nextId = 3;
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-reg-")));
  jobs.put({ ...toolJob("R"), taskId: 1, status: "completed", exitCode: 0, exitCodeKnown: true });
  let entries = 0;
  const deps = toolDeps(board, {
    jobs, board: () => board, commit: (s) => { board = s; }, appendEntry: () => { entries++; },
  });
  const r = await createTodoTool(deps).execute({ action: "clear" });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("Cleared 1 tasks");
  expect(board.tasks.map((t) => t.id)).toEqual([2]);
  expect(jobs.get("R")?.purged).toBe(true);
  expect(entries).toBe(1);
});

it("bg_run binds pending and advances to in_progress on success", async () => {
  let board = emptyBoard();
  board.tasks = [{ id: 1, subject: "a", status: "pending" }];
  board.nextId = 2;
  let commits = 0;
  let req: any;
  const deps = toolDeps(board, {
    board: () => board,
    commit: (s) => { commits++; board = s; },
    spawn: (r) => { req = r; return { ok: true, jobId: "bg_x" }; },
  });
  const r = await createBgRunTool(deps).execute({ command: "sleep 1", task_id: 1 });
  expect(r.content[0].text).toContain("Started bg_x");
  expect(req.command).toBe("sleep 1");
  expect(board.tasks[0].status).toBe("in_progress");
  expect(board.tasks[0].jobs).toEqual(["bg_x"]);
  expect(commits).toBe(1);
});

it("bg_run parameter/status/capacity error branches", async () => {
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress" },
    { id: 2, subject: "b", status: "in_progress" },
    { id: 3, subject: "c", status: "parked", park: { reason: "r", at: 1, from: "pending" } },
  ];
  b.nextId = 4;
  const tool = createBgRunTool(toolDeps(b));
  expect((await tool.execute({ command: "  " })).isError).toBe(true);
  expect((await tool.execute({ command: "true" })).content[0].text).toContain("task_id required");
  expect((await tool.execute({ command: "true", task_id: 99 })).content[0].text).toContain("not found");
  expect((await tool.execute({ command: "true", task_id: 3 })).content[0].text).toContain("parked");

  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-reg-")));
  for (let i = 0; i < 10; i++) jobs.put({ ...toolJob(`r${i}`), status: "running", endedAt: null });
  const full = createBgRunTool(toolDeps(b, { jobs }));
  expect((await full.execute({ command: "true", task_id: 1 })).content[0].text).toContain("capacity full");
});

it("An error during the bg_run bind stage kills the job and returns isError", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const killed: string[] = [];
  const deps = toolDeps(b, {
    commit: () => { throw new Error("commit boom"); },
    spawn: () => ({ ok: true, jobId: "bg_x" }),
    kill: (id) => { killed.push(id); },
  });
  const r = await createBgRunTool(deps).execute({ command: "true", task_id: 1 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("bind failed");
  expect(killed).toEqual(["bg_x"]);
});

it("verify unknown task and no verify command branches", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }];
  b.nextId = 2;
  const tool = createTodoTool(toolDeps(b));
  expect((await tool.execute({ action: "verify", id: 99 })).isError).toBe(true);
  expect((await tool.execute({ action: "verify", id: 1 })).content[0].text).toContain("no verify command");
});

it("clear scope:all without force is rejected; tasks bound to running jobs are skipped", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "done", status: "completed", jobs: ["bg_a"] }];
  b.nextId = 2;
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-reg-")));
  jobs.put({ ...toolJob("bg_a"), taskId: 1, status: "running", endedAt: null });
  const tool = createTodoTool(toolDeps(b, {
    jobs,
    ruleCtx: () => ({ wipLimit: 1, now: 1, facts: jobFactsOf(jobs) }),
  }));
  expect((await tool.execute({ action: "clear", scope: "all" })).isError).toBe(true);
  const skipped = await tool.execute({ action: "clear", scope: "completed" });
  expect(skipped.content[0].text).toContain("skipped");
});

it("bg_run may omit task_id when exactly one task is in_progress", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }];
  b.nextId = 2;
  let taskId: number | undefined;
  const deps = toolDeps(b, {
    spawn: (r) => { taskId = r.taskId; return { ok: true, jobId: "bg_x" }; },
  });
  const r = await createBgRunTool(deps).execute({ command: "true" });
  expect(r.content[0].text).toContain("Started");
  expect(taskId).toBe(1);
});

it("bg_kill missing job_id returns isError", async () => {
  const r = await createBgKillTool(toolDeps(emptyBoard())).execute({});
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("job_id");
});

const toolJob = (id: string): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: 2,
  fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending",
});
