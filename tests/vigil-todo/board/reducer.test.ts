import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { applyMutation } from "../../../src/vigil-todo/board/reducer.js";
import type { JobFacts, RuleContext } from "../../../src/vigil-todo/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true } as JobFacts,
});

describe("create", () => {
  it("single and batch creates assign consecutive ids", () => {
    const a = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx());
    expect(a.op.kind).toBe("create");
    const b = applyMutation(a.state, { action: "create", tasks: [{ subject: "b" }, { subject: "c" }] }, ctx());
    expect(b.state.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(b.state.nextId).toBe(4);
  });
  it("empty subject is rejected and state is unchanged (Review Focus 1)", () => {
    const s = emptyBoard();
    const r = applyMutation(s, { action: "create", subject: "   " }, ctx());
    expect(r.op).toEqual({ kind: "error", message: "subject required for create" });
    expect(r.state).toBe(s);
  });
  it("subject and tasks[] are mutually exclusive", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", tasks: [{ subject: "b" }] }, ctx());
    expect(r.op.kind).toBe("error");
  });
  it("blockedBy self-reference / missing / deleted are all rejected (Review Focus 1)", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "b", blockedBy: [99] }, ctx()).op.kind).toBe("error");
    s = applyMutation(s, { action: "update", id: 1, status: "deleted" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "c", blockedBy: [1] }, ctx()).op.kind).toBe("error");
    expect(applyMutation(s, { action: "update", id: 1, addBlockedBy: [1] }, ctx()).op.kind).toBe("error");
  });
  it("non-object metadata is rejected (Review Focus 1)", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", metadata: "x" as never }, ctx());
    expect(r.op.kind).toBe("error");
  });
});

describe("R16 read-only fields", () => {
  it.each(["jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged"])(
    "model write to %s is rejected (F66)", (field) => {
      const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
      const r = applyMutation(s, { action: "update", id: 1, [field]: [] } as never, ctx());
      expect(r.op.kind).toBe("error");
      expect((r.op as { message: string }).message).toContain(field);
    });
});

describe("update and inProgressSince", () => {
  it("entering in_progress refreshes inProgressSince", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].inProgressSince).toBe(1000);
    expect(s.tasks[0].statusSince).toBe(1000);
  });
  it("rejected when there are no mutable fields", () => {
    const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "update", id: 1 }, ctx()).op.kind).toBe("error");
  });
  it("no change returns changed:false", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    const r = applyMutation(s, { action: "update", id: 1, subject: "a" }, ctx());
    expect(r.op).toMatchObject({ kind: "update", changed: false });
  });
});

describe("delete exit", () => {
  it("pending with no output can be deleted; jobs or evidence make it undeletable", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("delete");
    s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s.tasks[0].jobs = ["bg_a"];
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("error");
  });
});

it("two →in_progress in one batch: with limit 1 only one succeeds (F2)", () => {
  const s = emptyBoard();
  s.tasks = [
    { id: 1, subject: "a", status: "pending" },
    { id: 2, subject: "b", status: "pending" },
  ];
  s.nextId = 3;
  const one = { ...ctx(), wipLimit: 1 };
  const a = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, one);
  expect(a.op.kind).toBe("update");
  const b = applyMutation(a.state, { action: "update", id: 2, status: "in_progress" }, one);
  expect(b.op.kind).toBe("error");
  expect(b.state.tasks.filter((t) => t.status === "in_progress")).toHaveLength(1);
});

describe("completion gate and field side effects (coverage hardening)", () => {
  it("completed requires evidence: rejected without evidence, allowed with passing evidence", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    s.tasks[0].jobs = ["bg_a"];
    expect(applyMutation(s, { action: "update", id: 1, status: "completed" }, ctx()).op.kind).toBe("error");
    s.tasks[0].inProgressSince = 0;
    s.tasks[0].evidence = [{
      ok: true, kind: "job", origin: "async", chainFinal: false, at: 1,
      known: true, fp: "fresh", ref: "bg_a", exitCode: 0,
    }];
    expect(applyMutation(s, { action: "update", id: 1, status: "completed" }, ctx()).op.kind).toBe("update");
  });

  it("metadata merges, null deletes, non-object is rejected", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, metadata: { a: 1 } }, ctx()).state;
    expect(s.tasks[0].metadata).toEqual({ a: 1 });
    s = applyMutation(s, { action: "update", id: 1, metadata: { a: null, b: 2 } }, ctx()).state;
    expect(s.tasks[0].metadata).toEqual({ b: 2 });
    expect(applyMutation(s, { action: "update", id: 1, metadata: "x" as never }, ctx()).op.kind).toBe("error");
  });

  it("accept:stale marks the evidence accepted", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    s.tasks[0].jobs = ["bg_a"];
    s.tasks[0].inProgressSince = 0;
    s.tasks[0].evidence = [{
      ok: true, kind: "job", origin: "async", chainFinal: false, at: 1,
      known: true, fp: "stale", ref: "bg_a", exitCode: 0,
    }];
    const r = applyMutation(s, { action: "update", id: 1, status: "completed", accept: "stale" }, ctx());
    expect(r.op.kind).toBe("update");
    expect(r.state.tasks[0].evidence?.[0].accepted).toBe(true);
  });
});
