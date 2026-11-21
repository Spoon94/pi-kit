import { describe, expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { checkStructure, isTransitionValid, type JobFacts, type RuleContext } from "../../src/board/invariants.js";

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
  hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true, ...over,
});
const ctx = (wipLimit = 3, f: Partial<JobFacts> = {}): RuleContext => ({ wipLimit, facts: facts(f), now: 1000 });
const t = (id: number, over: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...over });
const board = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

describe("转移表", () => {
  it("completed 只能到 deleted；parked 不能由 completed 进入", () => {
    expect(isTransitionValid("completed", "deleted")).toBe(true);
    expect(isTransitionValid("completed", "parked")).toBe(false);
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
    expect(isTransitionValid("deleted", "pending")).toBe(false);
    expect(isTransitionValid("pending", "parked")).toBe(true);
    expect(isTransitionValid("parked", "in_progress")).toBe(true);
  });
  it("同值幂等", () => expect(isTransitionValid("parked", "parked")).toBe(true));
});

describe("R1 WIP 上限", () => {
  it("已满时拒绝第四个 in_progress（F1）", () => {
    const s = board([t(1, { status: "in_progress" }), t(2, { status: "in_progress" }), t(3, { status: "in_progress" }), t(4)]);
    expect(checkStructure(s, s.tasks[3], { id: 4, status: "in_progress" }, ctx())).toMatch(/WIP full \(3\/3\)/);
  });
  it("parked 不占位（F19）", () => {
    const s = board([t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }), t(2)]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx(1))).toBeUndefined();
  });
});

describe("R4 依赖", () => {
  it("依赖 in_progress 时拒绝（F26 反面）", () => {
    const s = board([t(1, { status: "in_progress" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toMatch(/blocked by #1/);
  });
  it("依赖 deleted 视为已满足（F26）", () => {
    const s = board([t(1, { status: "deleted" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toBeUndefined();
  });
});

describe("R9/R13 park 与 defer", () => {
  it("deferred 不许直接开工（F28）", () => {
    const s = board([t(1, { defer: { untilRoot: "bg_a", reason: "r", at: 1 } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "in_progress" }, ctx())).toMatch(/deferred → bg_a/);
  });
  it("parked 施加 defer 被拒并给两步解法（F39）", () => {
    const s = board([t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, defer: { untilJob: "bg_a", reason: "r" } }, ctx()))
      .toMatch(/status:"pending"/);
  });
  it("deferred 施加 park 被拒并给两步解法（F39）", () => {
    const s = board([t(1, { defer: { untilRoot: "bg_a", reason: "r", at: 1 } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "parked", reason: "r" }, ctx())).toMatch(/defer:null/);
  });
});

describe("R14 让位与 defer 前置", () => {
  it("有 running 作业时让位被拒（F54）", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(3, { hasRunning: () => true })))
      .toMatch(/cannot yield or defer/);
  });
  it("有 running 作业时施加 defer 同样被拒（F62）", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, defer: { untilJob: "bg_b", reason: "r" } }, ctx(3, { hasRunning: () => true })))
      .toMatch(/cannot yield or defer/);
  });
  it("有退避链时让位被拒", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(3, { hasBackoff: () => true })))
      .toMatch(/cannot yield or defer/);
  });
});

describe("R17 移交冻结", () => {
  it("adoptedAway 任务拒绝一切变更（F97）", () => {
    const s = board([t(1, { metadata: { adoptedAway: { session: "sess-B" } } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "in_progress" }, ctx())).toMatch(/sess-B/);
  });
});
