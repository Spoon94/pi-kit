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

it("F106: with A blocked by B, B addBlockedBy[1] is rejected; the message points to removeBlockedBy", () => {
  const s = b([t(1, { blockedBy: [2] }), t(2)]);
  const r = applyMutation(s, { action: "update", id: 2, addBlockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  const msg = (r.op as { message: string }).message;
  expect(msg).toContain("cycle");
  expect(msg).toContain("removeBlockedBy");
});

it("F107: the last edge of the three-node cycle A→C→B→A is rejected (graph traversal required)", () => {
  const s = b([t(1, { blockedBy: [3] }), t(2, { blockedBy: [1] }), t(3)]);
  const r = applyMutation(s, { action: "update", id: 3, addBlockedBy: [2] }, ctx());
  expect(r.op.kind).toBe("error");
  const msg = (r.op as { message: string }).message;
  expect(msg).toContain("cycle");
  const cycle = detectCycle(s, { taskId: 3, deps: [2] });
  expect(cycle).toHaveLength(4);                 // #x → #y → #z → #x
  expect(new Set(cycle)).toEqual(new Set([1, 2, 3]));
});

it("F108: mutual references within a batch create are rejected", () => {
  const r = applyMutation(emptyBoard(), {
    action: "create",
    tasks: [{ subject: "a", blockedBy: [2] }, { subject: "b", blockedBy: [1] }],
  }, ctx());
  expect(r.op.kind).toBe("error");
});

it("create's blockedBy is rejected when it joins a historical cycle (R21 create branch)", () => {
  const s = b([t(1, { blockedBy: [2] }), t(2, { blockedBy: [1] })]);
  const r = applyMutation(s, { action: "create", subject: "c", blockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  expect((r.op as { message: string }).message).toContain("cycle");
});

it("F109: self-cycle addBlockedBy[itself] is rejected (existing guard does not regress)", () => {
  const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
  const r = applyMutation(s, { action: "update", id: 1, addBlockedBy: [1] }, ctx());
  expect(r.op.kind).toBe("error");
  expect((r.op as { message: string }).message).toMatch(/itself/);
});

it("F110: historical snapshot with a cycle + free WIP slot → doctor reports nothing actionable; panel first row has the marker", () => {
  const s = b([t(1, { blockedBy: [3] }), t(2, { blockedBy: [1] }), t(3, { blockedBy: [2] })]);
  const cfg = { ...DEFAULTS, wipLimit: 3 };
  const rows = renderPanel(s, jobs(), cfg);
  expect(rows[0]).toContain("nothing actionable");
  const doc = renderDoctor(s, jobs(), false, undefined, {
    purgedRoots: 0, retentionOverdue: 0, orphanJobs: 0, wipLimit: 3,
  });
  expect(doc).toContain("nothing actionable");
  expect(doc).toContain("Dependency cycle detected");
  expect(doc).toMatch(/#\d+/);
});

it("F111: diamond DAG must not report a false cycle; next works normally", () => {
  const s = b([t(1), t(2, { blockedBy: [1] }), t(3, { blockedBy: [1] }), t(4, { blockedBy: [2, 3] })]);
  expect(detectCycle(s)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(1);
  const cfg = { ...DEFAULTS, wipLimit: 3 };
  expect(renderPanel(s, jobs(), cfg)[0]).not.toContain("nothing actionable");
  expect(renderDoctor(s, jobs(), false)).not.toContain("Dependency cycle detected");
  const r = applyMutation(s, { action: "update", id: 4, addBlockedBy: [2] }, ctx());
  expect(r.op.kind).toBe("update");              // duplicate dependency does not report a false cycle
});
