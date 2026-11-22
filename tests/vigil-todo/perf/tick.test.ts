import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sweepAll, type SweepDeps } from "../../../src/vigil-todo/bind/sweep.js";
import { createBoardStore } from "../../../src/vigil-todo/board/store.js";
import { emptyBoard, type Task } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import { renderPanel } from "../../../src/vigil-todo/ui/panel.js";
import { needsTimer } from "../../../src/vigil-todo/wake/deliver.js";

const build = (nTask: number, nJob: number): SweepDeps => {
  const boards = createBoardStore();
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-tick-")));
  const b = emptyBoard();
  b.tasks = Array.from({ length: nTask }, (_, i): Task => ({
    id: i + 1, subject: `t${i}`, status: i % 3 === 0 ? "completed" : "pending",
    statusSince: 1, inProgressSince: 0,
  }));
  b.nextId = nTask + 1;
  boards.commit("S", b);
  for (let i = 0; i < nJob; i++) {
    const job: Job = {
      id: `j${i}`, label: `j${i}`, command: "true", logPath: "/tmp/x", cwd: "/tmp", pid: 1,
      status: i % 4 === 0 ? "running" : "completed", exitCode: 0, exitCodeKnown: true,
      startedAt: 100 + i, endedAt: i % 4 === 0 ? null : 200 + i,
      fpStart: "A", fpEnd: "A", fpVerdict: "fresh", interferers: [],
      rootId: `j${i}`, attempt: 1, taskId: (i % nTask) + 1, sessionId: "S",
      evidenceApplied: true, finalized: true, notifyState: "acked",
    };
    jobs.put(job);
  }
  return { boards, jobs, cfg: DEFAULTS, now: 1000, sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
};

const measure = (d: SweepDeps) => {
  const board = d.boards.get("S");
  const t0 = performance.now();
  d.jobs.gc(DEFAULTS.completedTtlMs, d.now);
  const t1 = performance.now();
  sweepAll(d);
  const t2 = performance.now();
  renderPanel(board, d.jobs, DEFAULTS);
  const t3 = performance.now();
  needsTimer(board, d.jobs, DEFAULTS);
  const t4 = performance.now();
  return { gc: t1 - t0, sweep: t2 - t1, render: t3 - t2, timer: t4 - t3, total: t4 - t0 };
};

it("full idle tick < 1ms at 50/20, 200/100, 200/300, and 200/2000", () => {
  for (const [nTask, nJob] of [[50, 20], [200, 100], [200, 300], [200, 2000]] as const) {
    const d = build(nTask, nJob);
    for (let i = 0; i < 5; i++) measure(d);                 // JIT warmup
    const samples = Array.from({ length: 50 }, () => measure(d));
    const mean = (k: "gc" | "sweep" | "render" | "timer" | "total"): number =>
      samples.reduce((n, s) => n + s[k], 0) / samples.length;
    const totals = samples.map((s) => s.total).sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)];
    console.log(`tick ${nTask}/${nJob}: mean gc ${mean("gc").toFixed(4)} + sweep ${mean("sweep").toFixed(4)} + render ${mean("render").toFixed(4)} + needsTimer ${mean("timer").toFixed(4)} = ${mean("total").toFixed(4)} ms; median total ${median.toFixed(4)} ms`);
    expect(median).toBeLessThan(1);
  }
});
