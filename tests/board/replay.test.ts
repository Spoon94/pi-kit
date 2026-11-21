import { expect, it } from "vitest";
import { decodeSnapshot, replayBranch } from "../../src/board/replay.js";
import { emptyBoard } from "../../src/board/types.js";

const snap = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  action: "update", params: {}, tasks, nextId: tasks.length + 1,
  counters: { turnsUsed: 7, wakeWatermark: 5, renudgeBudget: 1 }, ...extra,
});

it("旧 4 状态快照可读，inProgressSince 走 fallback（F11/F52）", () => {
  const s = decodeSnapshot(snap([{ id: 1, subject: "a", status: "in_progress", statusSince: 42 }]));
  expect(s?.tasks[0].inProgressSince).toBe(42);
  const s0 = decodeSnapshot(snap([{ id: 1, subject: "a", status: "in_progress" }]));
  expect(s0?.tasks[0].inProgressSince).toBe(0);
});

it("parked 状态可解码", () => {
  const s = decodeSnapshot(snap([{ id: 1, subject: "a", status: "parked", park: { reason: "r", at: 1, from: "pending" } }]));
  expect(s?.tasks[0].status).toBe("parked");
});

it("非法快照整体丢弃，不抛异常（Review Focus 2）", () => {
  expect(decodeSnapshot(null)).toBeUndefined();
  expect(decodeSnapshot({ tasks: "x", nextId: 1 })).toBeUndefined();
  expect(decodeSnapshot(snap([{ id: 1 }]))).toBeUndefined();
  expect(decodeSnapshot(snap([{ id: 1, subject: "a", status: "bogus" }]))).toBeUndefined();
});

it("counters 缺失时归零，存在时保留（F37）", () => {
  expect(decodeSnapshot({ tasks: [], nextId: 1 })?.counters).toEqual({ turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 });
  expect(decodeSnapshot(snap([]))?.counters.turnsUsed).toBe(7);
});

it("分支取最后一条有效快照；无则空 board（F9）", () => {
  const entries = [
    { type: "custom", customType: "rpiv-todo-state", data: snap([{ id: 1, subject: "a", status: "pending" }]) },
    { type: "message", message: { role: "assistant" } },
    { type: "custom", customType: "rpiv-todo-state", data: snap([{ id: 1, subject: "a", status: "completed" }]) },
    { type: "custom", customType: "rpiv-todo-state", data: { broken: true } },
  ];
  expect(replayBranch(entries).tasks[0].status).toBe("completed");
  expect(replayBranch([])).toEqual(emptyBoard());
});

it("无 custom entry 时回退 toolResult.details", () => {
  const entries = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: snap([{ id: 1, subject: "a", status: "pending" }]) } }];
  expect(replayBranch(entries).tasks).toHaveLength(1);
});
