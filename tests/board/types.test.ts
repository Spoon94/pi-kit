import { expect, it } from "vitest";
import { EVIDENCE_RING, emptyBoard } from "../../src/board/types.js";

it("emptyBoard zeroes counters and does not reuse array references", () => {
  const a = emptyBoard();
  const b = emptyBoard();
  expect(a).toEqual({ tasks: [], nextId: 1, counters: { turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 } });
  a.tasks.push({ id: 1, subject: "x", status: "pending" });
  expect(b.tasks).toHaveLength(0);
  expect(EVIDENCE_RING).toBe(8);
});
