import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { detectCycle } from "../../src/board/graph.js";
import { applyMutation } from "../../src/board/reducer.js";
import { selectNext } from "../../src/board/selectors.js";
import { emptyBoard, type Task } from "../../src/board/types.js";
import type { RuleContext } from "../../src/board/invariants.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { renderDoctor, renderPanel } from "../../src/ui/panel.js";

const ctx = (wipLimit = 3): RuleContext => ({
  wipLimit, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});
const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const jobs = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-cycle-")));

it("F106：A⛓B 后 B addBlockedBy[1] 被拒，文案给 removeBlockedBy 出口", () => {
  const s = b([t(1, { blockedBy: [2] }), t(2)]);
  const r = applyMutation(s, { action: "update", id: 2, addBlockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  const msg = (r.op as { message: string }).message;
  expect(msg).toContain("cycle");
  expect(msg).toContain("removeBlockedBy");
});

it("F107：三节点环 A⛓C⛓B⛓A 的最后一边被拒（必须图遍历）", () => {
  const s = b([t(1, { blockedBy: [3] }), t(2, { blockedBy: [1] }), t(3)]);
  const r = applyMutation(s, { action: "update", id: 3, addBlockedBy: [2] }, ctx());
  expect(r.op.kind).toBe("error");
  const msg = (r.op as { message: string }).message;
  expect(msg).toContain("cycle");
  const cycle = detectCycle(s, { taskId: 3, deps: [2] });
  expect(cycle).toHaveLength(4);                 // #x ⛓ #y ⛓ #z ⛓ #x
  expect(new Set(cycle)).toEqual(new Set([1, 2, 3]));
});

it("F108：create 批量内互指被拒", () => {
  const r = applyMutation(emptyBoard(), {
    action: "create",
    tasks: [{ subject: "a", blockedBy: [2] }, { subject: "b", blockedBy: [1] }],
  }, ctx());
  expect(r.op.kind).toBe("error");
});

it("create 的 blockedBy 并入历史环时被拒（R21 create 分支）", () => {
  const s = b([t(1, { blockedBy: [2] }), t(2, { blockedBy: [1] })]);
  const r = applyMutation(s, { action: "create", subject: "c", blockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  expect((r.op as { message: string }).message).toContain("cycle");
});

it("F109：自环 addBlockedBy[自身] 被拒（既有防线不回归）", () => {
  const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
  const r = applyMutation(s, { action: "update", id: 1, addBlockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  expect((r.op as { message: string }).message).toMatch(/itself/);
});

it("F110：历史快照带环 + WIP 有位 ⇒ doctor 报无可推进，面板首行有标记", () => {
  const s = b([t(1, { blockedBy: [3] }), t(2, { blockedBy: [1] }), t(3, { blockedBy: [2] })]);
  const cfg = { ...DEFAULTS, wipLimit: 3 };
  const rows = renderPanel(s, jobs(), cfg);
  expect(rows[0]).toContain("无可推进");
  const doc = renderDoctor(s, jobs(), false, undefined, {
    purgedRoots: 0, retentionOverdue: 0, orphanJobs: 0, wipLimit: 3,
  });
  expect(doc).toContain("无可推进");
  expect(doc).toContain("检测到依赖环");
  expect(doc).toMatch(/#\d+/);
});

it("F111：菱形 DAG 不得误报环，next 正常", () => {
  const s = b([t(1), t(2, { blockedBy: [1] }), t(3, { blockedBy: [1] }), t(4, { blockedBy: [2, 3] })]);
  expect(detectCycle(s)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(1);
  const cfg = { ...DEFAULTS, wipLimit: 3 };
  expect(renderPanel(s, jobs(), cfg)[0]).not.toContain("无可推进");
  expect(renderDoctor(s, jobs(), false)).not.toContain("检测到依赖环");
  const r = applyMutation(s, { action: "update", id: 4, addBlockedBy: [2] }, ctx());
  expect(r.op.kind).toBe("update");              // 重复依赖不误报
});
