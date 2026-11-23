import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sweepAll, type SweepDeps } from "../../../src/vigil-todo/bind/sweep.js";
import { createBoardStore } from "../../../src/vigil-todo/board/store.js";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";

it("2000 dangling roots are reaped in one pass (< 5ms compute, one save)", () => {
  const boards = createBoardStore();
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-reap-")));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "pending" }];
  b.nextId = 2;
  boards.commit("S", b);
  for (let i = 0; i < 2000; i++) {
    jobs.put({
      id: `j${i}`, label: `j${i}`, command: "true", logPath: "/tmp/x", cwd: "/tmp", pid: 1,
      status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
      fpVerdict: "fresh", interferers: [], rootId: `j${i}`, attempt: 1,
      taskId: 99, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "acked",
    });
  }

  let saves = 0;
  jobs.save = () => { saves++; };                 // isolate CPU from the one-time fsync
  const d: SweepDeps = { boards, jobs, cfg: DEFAULTS, now: 1000, sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
  const t0 = performance.now();
  sweepAll(d);
  const ms = performance.now() - t0;
  console.log(`reap 2000 dangling roots: ${ms.toFixed(2)} ms (compute; save calls ${saves})`);

  expect(ms).toBeLessThan(5);
  expect(saves).toBe(1);                          // the purge still persists exactly once
  expect(jobs.all().every((j) => j.purged)).toBe(true);
});
