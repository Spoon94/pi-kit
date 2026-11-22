import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { completedSummary, selectNext, wipCount } from "../../src/board/selectors.js";

const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

it("next is empty when WIP is full or capacity is full (F40)", () => {
  const s = b([t(1, { status: "in_progress" }), t(2)]);
  expect(selectNext(s, 1, false)).toBeUndefined();
  expect(selectNext(s, 3, true)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(2);
});

it("skips parked / unmet dependencies, ordered by ascending id (F19)", () => {
  const s = b([
    t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }),
    t(3, { blockedBy: [1] }),
    t(4),
  ]);
  expect(selectNext(s, 1, false)?.id).toBe(4);
  expect(wipCount(s)).toBe(0);
});

it("completed summary counts fp:? and reverified (F58)", () => {
  const done = (id: number, fp: "fresh" | "unknown", note?: string): Task => t(id, {
    status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp, ref: `bg_${id}`, exitCode: 0, note }],
  });
  const s = b([done(1, "fresh"), done(2, "unknown"), done(3, "fresh", "reverified"), t(4)]);
  expect(completedSummary(s)).toMatchObject({ done: 3, total: 4, allExit0: true, fpUnknown: 1, reverified: 1 });
});

it("does not falsely report all exit 0 when chainFinal is evicted by the ring (MINOR #3)", () => {
  const evidence = Array.from({ length: 8 }, (_, i) => ({
    ok: false, kind: "job" as const, origin: "async" as const, chainFinal: false,
    at: i, known: true, fp: "fresh" as const, exitCode: 1, ref: `bg_${i}`,
  }));
  const s = b([t(1, { status: "completed", jobs: ["bg_a"], evidence })]);
  const sum = completedSummary(s);
  expect(sum.allExit0).toBe(false);
  expect(sum.evidenceRolled).toBe(true);
});
