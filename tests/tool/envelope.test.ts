import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { buildResult } from "../../src/tool/envelope.js";

it("拒绝带 isError 与 details.error（F29）", () => {
  const r = buildResult({ action: "update", id: 1 }, emptyBoard(), { kind: "error", message: "boom" });
  expect(r.isError).toBe(true);
  expect(r.details.error).toBe("boom");
  expect(r.content[0].text).toContain("boom");
});

it("成功不带 isError，details 含 counters", () => {
  const r = buildResult({ action: "create", subject: "a" }, emptyBoard(), { kind: "create", ids: [1] });
  expect(r.isError).toBeUndefined();
  expect(r.details.counters).toEqual({ turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 });
});
