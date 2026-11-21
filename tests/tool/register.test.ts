import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { createBgRunTool, detectToolConflict, preflight, type ToolDeps } from "../../src/tool/register.js";
import { DEFAULTS } from "../../src/lib/config.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 1, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("旧包占位时判定冲突（F13）", () => {
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:@juicesharp/rpiv-todo" } }], "npm:pi-kit")).toBe(true);
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:pi-kit" } }], "npm:pi-kit")).toBe(false);
  expect(detectToolConflict([], "npm:pi-kit")).toBe(false);
});

it("L1 预检拦明显违规并给文案", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  const r = preflight({ toolName: "todo", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx());
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain("WIP full");
});

it("L1 跳过嵌套调用（F15）", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  expect(preflight({ toolName: "todo", parentToolCallId: "p1", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx())).toBeUndefined();
});

it("L1 不管别的工具（F14）", () => {
  expect(preflight({ toolName: "read", input: { path: "a" } }, emptyBoard(), ctx())).toBeUndefined();
});

it("畸形 input 不抛（Review Focus 1）", () => {
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

it("同一 job 不得绑定两个任务（F30）", async () => {
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

it("bg_run 指向 pending 且 WIP 满被拒，不绑不推进（F41）", async () => {
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
