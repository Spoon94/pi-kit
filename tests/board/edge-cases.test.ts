import { expect, it } from "vitest";
import { applyMutation } from "../../src/board/reducer.js";
import type { BoardState, Task } from "../../src/board/types.js";
import { emptyBoard } from "../../src/board/types.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});
const board3 = (): BoardState => ({
  ...emptyBoard(),
  tasks: [
    { id: 1, subject: "a", status: "pending" },
    { id: 2, subject: "b", status: "pending" },
    { id: 3, subject: "c", status: "pending" },
  ] as Task[],
  nextId: 4,
});
const msg = (r: ReturnType<typeof applyMutation>) => (r.op as { message: string }).message;

it("update 组合：reason/accept 仅在对应状态；completed 与改 verify 冲突", () => {
  let s = board3();
  expect(msg(applyMutation(s, { action: "update", id: 1, status: "completed", reason: "x" }, ctx())))
    .toContain('reason is only valid with status:"parked"');
  expect(msg(applyMutation(s, { action: "update", id: 1, accept: "stale" }, ctx())))
    .toContain('accept:"stale" is only valid with status:"completed"');
  expect(msg(applyMutation(s, { action: "update", id: 1, status: "parked", reason: "r", accept: "stale" }, ctx())))
    .toContain('accept:"stale"');

  s = applyMutation(emptyBoard(), { action: "create", subject: "v", verify: { kind: "command", command: "npm test" } }, ctx()).state;
  expect(msg(applyMutation(s, { action: "update", id: 1, status: "completed", verify: { kind: "command", command: "true" } }, ctx())))
    .toContain("cannot change verify and complete");
});

it("metadata：循环/深嵌套/超大/BigInt 拒绝，合法嵌套保留", () => {
  const base = board3();
  const cyclic: any = { a: 1 }; cyclic.self = cyclic;
  expect(msg(applyMutation(base, { action: "update", id: 1, metadata: cyclic }, ctx()))).toContain("JSON-safe");

  let deep: any = { leaf: true };
  for (let i = 0; i < 100; i++) deep = { child: deep };
  expect(msg(applyMutation(base, { action: "update", id: 1, metadata: deep }, ctx()))).toContain("JSON-safe");

  const huge: Record<string, number> = {};
  for (let i = 0; i <= 10_000; i++) huge[`k${i}`] = i;
  expect(msg(applyMutation(base, { action: "update", id: 1, metadata: huge }, ctx()))).toContain("JSON-safe");

  expect(msg(applyMutation(base, { action: "update", id: 1, metadata: { a: 1n } as never }, ctx()))).toContain("JSON-safe");

  const ok = applyMutation(base, { action: "update", id: 1, metadata: { a: { b: [1, 2] } } }, ctx());
  expect(ok.op.kind).toBe("update");
  expect(ok.state.tasks[0].metadata).toEqual({ a: { b: [1, 2] } });

  expect(msg(applyMutation(base, { action: "create", subject: "x", metadata: cyclic }, ctx()))).toContain("JSON-safe");
});

it("blockedBy：重复去重；add/remove 同 id 拒绝；非安全整数拒绝", () => {
  const created = applyMutation(board3(), { action: "create", subject: "d", blockedBy: [2, 2] }, ctx());
  expect(created.state.tasks.find((t) => t.id === 4)?.blockedBy).toEqual([2]);

  const added = applyMutation(board3(), { action: "update", id: 1, addBlockedBy: [2, 2] }, ctx());
  expect(added.state.tasks[0].blockedBy).toEqual([2]);

  expect(msg(applyMutation(board3(), { action: "update", id: 1, addBlockedBy: [2], removeBlockedBy: [2] }, ctx())))
    .toContain("both added and removed");
  expect(msg(applyMutation(board3(), { action: "update", id: 1, addBlockedBy: [Number.NaN] }, ctx())))
    .toContain("safe integer");
  expect(msg(applyMutation(board3(), { action: "create", subject: "d", blockedBy: [1.5] }, ctx())))
    .toContain("safe integer");
});

it("verify.command：空/超长/NUL 拒；换行允许", () => {
  const s = board3();
  expect(msg(applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "  " } }, ctx())))
    .toContain("verify.command required");
  expect(msg(applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "x".repeat(4097) } }, ctx())))
    .toContain("too long");
  expect(msg(applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "a\u0000b" } }, ctx())))
    .toContain("NUL");
  const ml = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "echo a\necho b" } }, ctx());
  expect(ml.op.kind).toBe("update");
  expect(msg(applyMutation(s, { action: "create", subject: "v", verify: { kind: "command", command: "" } }, ctx())))
    .toContain("verify.command required");
});

it("id 非安全整数与 nextId 溢出拒绝", () => {
  const s = board3();
  for (const id of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(msg(applyMutation(s, { action: "update", id } as never, ctx()))).toContain("safe integer");
    expect(msg(applyMutation(s, { action: "get", id } as never, ctx()))).toContain("safe integer");
    expect(msg(applyMutation(s, { action: "delete", id } as never, ctx()))).toContain("safe integer");
  }
  const overflow = { ...s, nextId: Number.MAX_SAFE_INTEGER };
  expect(msg(applyMutation(overflow, { action: "create", subject: "x" }, ctx()))).toContain("overflow");
});

it("tasks[] 单项畸形：subject 非字符串/缺省、metadata 非对象", () => {
  const s = board3();
  expect(msg(applyMutation(s, { action: "create", tasks: [{ subject: 7 as never }] }, ctx()))).toContain("subject required");
  expect(msg(applyMutation(s, { action: "create", tasks: [{ subject: "a", metadata: "x" as never }] }, ctx())))
    .toContain("metadata must be an object");
  expect(msg(applyMutation(s, { action: "create", tasks: [] }, ctx()))).toContain("subject required");
});

it("clear：非法 scope 与非布尔 force 拒绝", () => {
  const s = board3();
  expect(msg(applyMutation(s, { action: "clear", scope: "bogus" } as never, ctx()))).toContain("invalid scope");
  expect(msg(applyMutation(s, { action: "clear", force: "yes" } as never, ctx()))).toContain("force must be a boolean");
});
