import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyMutation } from "../../../src/vigil-todo/board/reducer.js";
import { replayBranch } from "../../../src/vigil-todo/board/replay.js";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { tailLines } from "../../../src/vigil-todo/lib/tail.js";
import type { RuleContext } from "../../../src/vigil-todo/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("with 200 tasks, median mutation p95 < 3ms (5 batches × 1000, after warmup)", () => {
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
  // JIT warmup: discard the first two batches
  for (let i = 0; i < 2; i++) batchP95();
  // take the median of 5 batch p95s to reduce sensitivity to one-off scheduling spikes
  const batches = Array.from({ length: 5 }, () => batchP95()).sort((a, b) => a - b);
  expect(batches[2]).toBeLessThan(3);
});

it("replaying 10k branch entries < 30ms", () => {
  const snap = { action: "update", params: {}, tasks: [{ id: 1, subject: "a", status: "pending" }], nextId: 2 };
  const entries = Array.from({ length: 10_000 }, () => ({ type: "custom", customType: "rpiv-todo-state", data: snap }));
  const t0 = performance.now();
  replayBranch(entries);
  expect(performance.now() - t0).toBeLessThan(30);
});

it("reading 20 lines from a 100MB log < 5ms (tail only)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "{{SECRET_f1k8q2zd}}")), "huge.log");
  writeFileSync(p, Buffer.alloc(100 * 1024 * 1024, "x"));
  writeFileSync(p, "\nlast line\n", { flag: "a" });
  const t0 = performance.now();
  const out = tailLines(p, 20, 8192);
  expect(performance.now() - t0).toBeLessThan(5);
  expect(out.at(-1)).toBe("last line");
});
