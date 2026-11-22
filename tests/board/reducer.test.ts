import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { applyMutation } from "../../src/board/reducer.js";
import type { JobFacts, RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true } as JobFacts,
});

describe("create", () => {
  it("单条与批量分配连续 id", () => {
    const a = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx());
    expect(a.op.kind).toBe("create");
    const b = applyMutation(a.state, { action: "create", tasks: [{ subject: "b" }, { subject: "c" }] }, ctx());
    expect(b.state.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(b.state.nextId).toBe(4);
  });
  it("空 subject 拒绝且状态不变（Review Focus 1）", () => {
    const s = emptyBoard();
    const r = applyMutation(s, { action: "create", subject: "   " }, ctx());
    expect(r.op).toEqual({ kind: "error", message: "subject required for create" });
    expect(r.state).toBe(s);
  });
  it("subject 与 tasks[] 互斥", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", tasks: [{ subject: "b" }] }, ctx());
    expect(r.op.kind).toBe("error");
  });
  it("blockedBy 自引用 / 不存在 / 已删除 均拒（Review Focus 1）", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "b", blockedBy: [99] }, ctx()).op.kind).toBe("error");
    s = applyMutation(s, { action: "update", id: 1, status: "deleted" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "c", blockedBy: [1] }, ctx()).op.kind).toBe("error");
    expect(applyMutation(s, { action: "update", id: 1, addBlockedBy: [1] }, ctx()).op.kind).toBe("error");
  });
  it("metadata 非对象拒绝（Review Focus 1）", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", metadata: "x" as never }, ctx());
    expect(r.op.kind).toBe("error");
  });
});

describe("R16 只读字段", () => {
  it.each(["jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged"])(
    "模型写 %s 被拒（F66）", (field) => {
      const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
      const r = applyMutation(s, { action: "update", id: 1, [field]: [] } as never, ctx());
      expect(r.op.kind).toBe("error");
      expect((r.op as { message: string }).message).toContain(field);
    });
});

describe("update 与 inProgressSince", () => {
  it("进入 in_progress 刷新 inProgressSince", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].inProgressSince).toBe(1000);
    expect(s.tasks[0].statusSince).toBe(1000);
  });
  it("无可变字段拒绝", () => {
    const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "update", id: 1 }, ctx()).op.kind).toBe("error");
  });
  it("无变更返回 changed:false", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    const r = applyMutation(s, { action: "update", id: 1, subject: "a" }, ctx());
    expect(r.op).toMatchObject({ kind: "update", changed: false });
  });
});

describe("delete 出口", () => {
  it("pending 无产出可删；有 jobs 或 evidence 不可删", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("delete");
    s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s.tasks[0].jobs = ["bg_a"];
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("error");
  });
});

it("同批两个 →in_progress，limit 1 时只一个成功（F2）", () => {
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

describe("完成门与字段副作用（覆盖补强）", () => {
  it("completed 需证据：无证据拒，有通过证据放行", () => {
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

  it("metadata 合并、null 删除、非对象拒绝", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, metadata: { a: 1 } }, ctx()).state;
    expect(s.tasks[0].metadata).toEqual({ a: 1 });
    s = applyMutation(s, { action: "update", id: 1, metadata: { a: null, b: 2 } }, ctx()).state;
    expect(s.tasks[0].metadata).toEqual({ b: 2 });
    expect(applyMutation(s, { action: "update", id: 1, metadata: "x" as never }, ctx()).op.kind).toBe("error");
  });

  it("accept:stale 标记证据 accepted", () => {
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
