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
  it("rejected without a reason (F22)", () => {
    expect(applyMutation(withTask(), { action: "update", id: 1, status: "parked" }, ctx()).op.kind).toBe("error");
  });
  it("with a reason, writes park and records from", () => {
    const r = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "needs sign-off" }, ctx());
    expect(r.state.tasks[0].park).toEqual({ reason: "needs sign-off", at: 1000, from: "pending" });
  });
  it("unpark clears park", () => {
    let s = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "r" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].park).toBeUndefined();
  });
});

describe("R15 verify changes", () => {
  it("changing the command writes manual evidence and disables automatic completion (F53)", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "true" } }, ctx()).state;
    const t = s.tasks[0];
    expect(t.verifyChanged).toBe(true);
    expect(t.evidence?.at(-1)).toMatchObject({ kind: "manual", origin: "tool", ok: false });
    expect(t.evidence?.at(-1)?.note).toContain("npm test");
  });
  it("setting the same command again has no side effects", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "npm test" } }, ctx()).state;
    expect(s.tasks[0].verifyChanged).toBeUndefined();
  });
});
