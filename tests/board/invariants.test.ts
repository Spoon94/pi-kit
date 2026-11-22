import { describe, expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { checkStructure, isTransitionValid, type JobFacts, type RuleContext } from "../../src/board/invariants.js";

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
  hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true, ...over,
});
const ctx = (wipLimit = 3, f: Partial<JobFacts> = {}): RuleContext => ({ wipLimit, facts: facts(f), now: 1000 });
const t = (id: number, over: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...over });
const board = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

describe("transition table", () => {
  it("completed can only go to deleted; parked cannot be entered from completed", () => {
    expect(isTransitionValid("completed", "deleted")).toBe(true);
    expect(isTransitionValid("completed", "parked")).toBe(false);
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
    expect(isTransitionValid("deleted", "pending")).toBe(false);
    expect(isTransitionValid("pending", "parked")).toBe(true);
    expect(isTransitionValid("parked", "in_progress")).toBe(true);
  });
  it("same-value transition is idempotent", () => expect(isTransitionValid("parked", "parked")).toBe(true));
});

describe("R1 WIP limit", () => {
  it("rejects a second in_progress when full (F1)", () => {
    const s = board([t(1, { status: "in_progress" }), t(2)]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx(1))).toMatch(/WIP full \(1\/1\)/);
  });
  it("parked does not take a slot (F19)", () => {
    const s = board([t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }), t(2)]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx(1))).toBeUndefined();
  });
});

describe("R4 dependencies", () => {
  it("rejected when a dependency is in_progress (F26 counter-case)", () => {
    const s = board([t(1, { status: "in_progress" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toMatch(/blocked by #1/);
  });
  it("deleted dependency counts as satisfied (F26)", () => {
    const s = board([t(1, { status: "deleted" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toBeUndefined();
  });
});

describe("R14 yield preconditions", () => {
  it("yield is rejected when a job is running (F54)", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(1, { hasRunning: () => true })))
      .toMatch(/cannot yield/);
  });
  it("yield is rejected when a backoff chain exists", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(1, { hasBackoff: () => true })))
      .toMatch(/cannot yield/);
  });
});
