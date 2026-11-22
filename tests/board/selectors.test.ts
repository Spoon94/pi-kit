import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { completedSummary, selectNext, wipCount } from "../../src/board/selectors.js";

const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

it("WIP 满或容量满时 next 为空（F40）", () => {
  const s = b([t(1, { status: "in_progress" }), t(2)]);
  expect(selectNext(s, 1, false)).toBeUndefined();
  expect(selectNext(s, 3, true)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(2);
});

it("跳过 parked / 依赖未清，按 id 升序（F19）", () => {
  const s = b([
    t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }),
    t(3, { blockedBy: [1] }),
    t(4),
  ]);
  expect(selectNext(s, 1, false)?.id).toBe(4);
  expect(wipCount(s)).toBe(0);
});

it("completed 汇总统计 fp:? 与 reverified（F58）", () => {
  const done = (id: number, fp: "fresh" | "unknown", note?: string): Task => t(id, {
    status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp, ref: `bg_${id}`, exitCode: 0, note }],
  });
  const s = b([done(1, "fresh"), done(2, "unknown"), done(3, "fresh", "reverified"), t(4)]);
  expect(completedSummary(s)).toMatchObject({ done: 3, total: 4, allExit0: true, fpUnknown: 1, reverified: 1 });
});

it("chainFinal 被环形挤出时不谎报 all exit 0（MINOR #3）", () => {
  const evidence = Array.from({ length: 8 }, (_, i) => ({
    ok: false, kind: "job" as const, origin: "async" as const, chainFinal: false,
    at: i, known: true, fp: "fresh" as const, exitCode: 1, ref: `bg_${i}`,
  }));
  const s = b([t(1, { status: "completed", jobs: ["bg_a"], evidence })]);
  const sum = completedSummary(s);
  expect(sum.allExit0).toBe(false);
  expect(sum.evidenceRolled).toBe(true);
});
