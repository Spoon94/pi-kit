import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { applyMutation } from "../../src/board/reducer.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
  ...over,
});
const withTask = () => applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;

describe("R7 park", () => {
  it("无 reason 拒（F22）", () => {
    expect(applyMutation(withTask(), { action: "update", id: 1, status: "parked" }, ctx()).op.kind).toBe("error");
  });
  it("带 reason 写入 park 并记 from", () => {
    const r = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "需拍板" }, ctx());
    expect(r.state.tasks[0].park).toEqual({ reason: "需拍板", at: 1000, from: "pending" });
  });
  it("unpark 清除 park", () => {
    let s = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "r" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].park).toBeUndefined();
  });
});

describe("R15 verify 改动", () => {
  it("改命令写 manual 证据并禁用自动完成（F53）", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "true" } }, ctx()).state;
    const t = s.tasks[0];
    expect(t.verifyChanged).toBe(true);
    expect(t.evidence?.at(-1)).toMatchObject({ kind: "manual", origin: "tool", ok: false });
    expect(t.evidence?.at(-1)?.note).toContain("npm test");
  });
  it("同命令重复设置不产生副作用", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "npm test" } }, ctx()).state;
    expect(s.tasks[0].verifyChanged).toBeUndefined();
  });
});
