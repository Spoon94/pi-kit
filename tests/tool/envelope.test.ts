import { describe, expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { buildResult } from "../../src/tool/envelope.js";

const board = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const list = (params: Record<string, unknown>, state = board([
  { id: 1, subject: "a", status: "pending" },
  { id: 2, subject: "b", status: "completed" },
  { id: 3, subject: "c", status: "deleted" },
])) => buildResult({ action: "list", ...params }, state, { kind: "list" }).content[0].text;

it("Rejects with isError and details.error (F29)", () => {
  const r = buildResult({ action: "update", id: 1 }, emptyBoard(), { kind: "error", message: "boom" });
  expect(r.isError).toBe(true);
  expect(r.details.error).toBe("boom");
  expect(r.content[0].text).toContain("boom");
});

it("Success has no isError and details contains counters", () => {
  const r = buildResult({ action: "create", subject: "a" }, emptyBoard(), { kind: "create", ids: [1] });
  expect(r.isError).toBeUndefined();
  expect(r.details.counters).toEqual({ turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 });
});

describe("F112/F113 list filtering", () => {
  it("Deleted hidden by default; shown only with includeDeleted", () => {
    expect(list({})).not.toContain("#3");
    expect(list({ includeDeleted: true })).toContain("#3");
  });
  it("status filter works and combines with includeDeleted", () => {
    expect(list({ status: "completed" })).toContain("#2");
    expect(list({ status: "completed" })).not.toContain("#1");
    expect(list({ status: "deleted" })).toBe("No tasks");
    expect(list({ status: "deleted", includeDeleted: true })).toContain("#3");
    expect(list({ status: "completed", includeDeleted: true })).not.toContain("#3");
  });
});

describe("F114 get full details", () => {
  it("Includes description/owner/verify/blockedBy/blocks/evidence/lastFailure/park", () => {
    const state = board([
      {
        id: 1, subject: "x", status: "parked", description: "the description", owner: "me",
        verify: { kind: "command", command: "npm test" },
        blockedBy: [2], jobs: ["bg_a"],
        evidence: [{ ok: false, kind: "job", origin: "async", chainFinal: false, at: 1, known: true, fp: "fresh", ref: "bg_a", exitCode: 1, note: "boom" }],
        lastFailure: { exitCode: 1, ref: "bg_a", at: 2, note: "boom" },
        park: { reason: "need decision", at: 3, from: "in_progress" },
      },
      { id: 2, subject: "dep", status: "pending" },
      { id: 3, subject: "downstream", status: "pending", blockedBy: [1] },
    ]);
    const text = buildResult({ action: "get", id: 1 }, state, { kind: "get", task: state.tasks[0] }).content[0].text;
    for (const needle of [
      "the description", "owner: me", "verify: command npm test", "blockedBy: #2",
      "blocks: #3", "jobs: bg_a", "evidence (last 1)", "exit=1", "lastFailure:",
      "park: need decision",
    ]) expect(text, needle).toContain(needle);
  });

  it("Minimal task prints only the first line; evidence variants and read-only time fields", () => {
    const minimal: Task = { id: 1, subject: "x", status: "in_progress" };
    expect(buildResult({ action: "get", id: 1 }, board([minimal]), { kind: "get", task: minimal }).content[0].text)
      .toBe("#1 [in_progress] x");

    const rich: Task = {
      id: 2, subject: "y", status: "parked", activeForm: "doing", verifyChanged: true,
      evidence: [
        { ok: false, kind: "job", origin: "async", chainFinal: false, at: 1, known: false, fp: "unknown", trigger: "self", accepted: true, note: "n" },
        { ok: true, kind: "job", origin: "async", chainFinal: false, at: 2, known: true, fp: "fresh", exitCode: null },
      ],
      lastFailure: { exitCode: null, ref: "r", at: 3 },
      park: { reason: "why", at: 4, from: "in_progress" },
      statusSince: 5, inProgressSince: 6,
    };
    const text = buildResult({ action: "get", id: 2 }, board([rich]), { kind: "get", task: rich }).content[0].text;
    for (const needle of [
      "activeForm: doing", "verifyChanged: true", "fail job async", "known=false",
      "trigger=self", "accepted", "exit=?", "lastFailure: ref=r exit=? at=3",
      "park: why", "statusSince: 5", "inProgressSince: 6",
    ]) expect(text, needle).toContain(needle);
    expect(text).not.toContain("at=3 note=");
  });

  it("action omitted and update message branches", () => {
    expect(buildResult({}, emptyBoard(), { kind: "list" }).content[0].text).toBe("No tasks");
    const state = board([{ id: 1, subject: "a", status: "pending" }]);
    expect(buildResult({ action: "update", id: 1 }, state,
      { kind: "update", id: 1, from: "pending", to: "in_progress", changed: true }).content[0].text)
      .toContain("pending → in_progress");
    expect(buildResult({ action: "update", id: 1 }, state,
      { kind: "update", id: 1, from: "pending", to: "pending", changed: true }).content[0].text)
      .toBe("Updated #1");
    expect(buildResult({ action: "update", id: 1 }, state,
      { kind: "update", id: 1, from: "pending", to: "pending", changed: false }).content[0].text)
      .toBe("No change: #1");
  });
});
