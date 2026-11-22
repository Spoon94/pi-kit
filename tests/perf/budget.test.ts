import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyMutation } from "../../src/board/reducer.js";
import { replayBranch } from "../../src/board/replay.js";
import { emptyBoard } from "../../src/board/types.js";
import { tailLines } from "../../src/lib/tail.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("200 任务下 mutation p95 中位数 < 3ms（5 批 × 1000，预热后）", () => {
  let s = emptyBoard();
  for (let i = 0; i < 200; i++) s = applyMutation(s, { action: "create", subject: `t${i}` }, ctx()).state;
  const batchP95 = (): number => {
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      applyMutation(s, { action: "update", id: (i % 200) + 1, activeForm: `f${i}` }, ctx());
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length * 0.95)];
  };
  // JIT 预热，丢弃前两批
  for (let i = 0; i < 2; i++) batchP95();
  // 5 批 p95 取中位数，降低单次调度尖峰敏感度
  const batches = Array.from({ length: 5 }, () => batchP95()).sort((a, b) => a - b);
  expect(batches[2]).toBeLessThan(3);
});

it("1 万条分支 replay < 30ms", () => {
  const snap = { action: "update", params: {}, tasks: [{ id: 1, subject: "a", status: "pending" }], nextId: 2 };
  const entries = Array.from({ length: 10_000 }, () => ({ type: "custom", customType: "rpiv-todo-state", data: snap }));
  const t0 = performance.now();
  replayBranch(entries);
  expect(performance.now() - t0).toBeLessThan(30);
});

it("100MB 日志取 20 行 < 5ms（只读尾部）", () => {
  const p = join(mkdtempSync(join(tmpdir(), "{{SECRET_f1k8q2zd}}")), "huge.log");
  writeFileSync(p, Buffer.alloc(100 * 1024 * 1024, "x"));
  writeFileSync(p, "\nlast line\n", { flag: "a" });
  const t0 = performance.now();
  const out = tailLines(p, 20, 8192);
  expect(performance.now() - t0).toBeLessThan(5);
  expect(out.at(-1)).toBe("last line");
});
