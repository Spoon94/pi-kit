import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../../src/vigil-todo/board/types.js";
import { createJobStore, runDir } from "../../../src/vigil-todo/jobs/store.js";
import { createMonitor } from "../../../src/vigil-todo/jobs/monitor.js";
import { spawnJob } from "../../../src/vigil-todo/jobs/spawn.js";
import { undeliveredRoots } from "../../../src/vigil-todo/wake/deliver.js";

const gc = (globalThis as { gc?: () => void }).gc;
const handles = (): number => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;

it("F152 undeliveredRoots stays linear: 200 tasks x 8 evidence in well under 1ms", () => {
  const boards = createJobStore(mkdtempSync(join(tmpdir(), "fw-perf-")));
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "fw-perf-jobs-")));
  const tasks: Task[] = [];
  for (let i = 1; i <= 200; i++) {
    const evidence = Array.from({ length: 8 }, (_, k) => ({
      ok: true, kind: "job" as const, origin: "async" as const, chainFinal: true, at: 1000 + k,
      known: true, fp: "fresh" as const, ref: `R${i}`,
    }));
    tasks.push({ id: i, subject: `t${i}`, status: "completed", evidence } as Task);
    jobs.put({
      id: `R${i}`, rootId: `R${i}`, label: "l", command: "true", logPath: "/tmp/x", cwd: "/tmp", pid: 1,
      status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
      fpVerdict: "fresh", interferers: [], attempt: 1, taskId: i, sessionId: "S",
      evidenceApplied: true, finalized: true, notifyState: "pending",
    } as never);
  }
  const board = { ...emptyBoard(), tasks, nextId: 201 };
  const sample = (): number => {
    const t0 = performance.now();
    const roots = undeliveredRoots({ board, jobs }, 0);
    const ms = performance.now() - t0;
    expect(roots).toHaveLength(200);
    return ms;
  };
  sample(); sample();                                     // JIT warm-up
  const times = Array.from({ length: 15 }, sample).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`undeliveredRoots 200x8: median ${median.toFixed(4)} ms (max ${times.at(-1)!.toFixed(4)})`);
  expect(median).toBeLessThan(1);
  void boards;
});

it("F156 650 real job cycles keep handles and timers flat without linear heap growth", async () => {
  expect(typeof gc, "--expose-gc not enabled").toBe("function");
  const cwd = mkdtempSync(join(tmpdir(), "fw-soak-"));
  const dir = runDir(cwd);
  const mon = createMonitor();
  const cycle = async (i: number): Promise<void> => {
    const r = spawnJob({ command: "true", cwd }, dir, Date.now() + i);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await new Promise<void>((resolve) => {
      mon.watch(r.job, () => resolve(), r.child);
    });
  };
  for (let i = 0; i < 100; i++) await cycle(i);           // warm-up
  await new Promise((r) => setImmediate(r));
  gc!(); gc!();
  const heap0 = process.memoryUsage().heapUsed;
  const handles0 = handles();
  const timers0 = mon.pending();

  for (let i = 100; i < 375; i++) await cycle(i);
  await new Promise((r) => setImmediate(r));
  gc!(); gc!();
  const heapMid = process.memoryUsage().heapUsed;

  for (let i = 375; i < 650; i++) await cycle(i);
  await new Promise((r) => setImmediate(r));
  gc!(); gc!();
  const heap1 = process.memoryUsage().heapUsed;
  const firstHalf = (heapMid - heap0) / 1024;
  const secondHalf = (heap1 - heapMid) / 1024;
  const growthKiB = (heap1 - heap0) / 1024;
  console.log(`real soak 550 cycles: heap ${growthKiB.toFixed(1)} KiB (first ${firstHalf.toFixed(1)}, second ${secondHalf.toFixed(1)}), handles ${handles0}→${handles()}, monitor pending ${timers0}→${mon.pending()}`);
  expect(growthKiB).toBeLessThan(512);
  expect(secondHalf).toBeLessThan(Math.max(firstHalf * 2, 256));   // no linear climb per cycle
  expect(handles()).toBe(handles0);
  expect(mon.pending()).toBe(0);
  mon.clearAll();
  writeFileSync(join(dir, "done.txt"), "ok");
}, 120_000);
