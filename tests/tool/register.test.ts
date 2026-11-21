import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { detectToolConflict, preflight } from "../../src/tool/register.js";
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
