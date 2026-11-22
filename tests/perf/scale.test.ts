import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sweepAll, type SweepDeps } from "../../src/bind/sweep.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

const build = (nTask: number, nJob: number): SweepDeps => {
  const boards = createBoardStore();
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-scale-")));
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

it("F123 空闲 sweepAll 固定开销 < 1ms（50/20、200/100、200/300，P3 基线）", () => {
  for (const [nTask, nJob] of [[50, 20], [200, 100], [200, 300]] as const) {
    const d = build(nTask, nJob);
    for (let i = 0; i < 20; i++) sweepAll(d);                 // JIT 预热
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      sweepAll(d);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const median = times[Math.floor(times.length / 2)];
    console.log(`sweepAll ${nTask} 任务/${nJob} 作业: mean ${mean.toFixed(4)} ms, median ${median.toFixed(4)} ms`);
    expect(median).toBeLessThan(1);
  }
});