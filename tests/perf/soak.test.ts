import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMonitor } from "../../src/jobs/monitor.js";
import { spawnJob } from "../../src/jobs/spawn.js";
import type { Job } from "../../src/jobs/types.js";

const gc = (globalThis as { gc?: () => void }).gc;
const handles = (): number => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
const job = (id: string): Job => ({
  id, label: id, command: "true", logPath: "/tmp/x.log", cwd: "/tmp", pid: 1,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending",
});

afterEach(() => vi.useRealTimers());

it("B1 monitor soak：5000 周期后堆增长接近平坦，句柄不增", async () => {
  expect(typeof gc, "--expose-gc 未生效").toBe("function");
  const mon = createMonitor();
  const cycle = (i: number): void => {
    const j = job(`bg_${i}`);
    mon.watch(j, () => {});
    mon.__emitForTest(j.id, 0);
  };
  for (let i = 0; i < 500; i++) cycle(i);             // 预热
  await new Promise((r) => setImmediate(r));
  gc!(); gc!();
  const heap0 = process.memoryUsage().heapUsed;
  const handles0 = handles();

  for (let i = 500; i < 5500; i++) cycle(i);
  await new Promise((r) => setImmediate(r));
  gc!(); gc!();
  const heap1 = process.memoryUsage().heapUsed;
  const handles1 = handles();
  const growthKiB = (heap1 - heap0) / 1024;
  console.log(`monitor soak: 5000 周期 heap 增长 ${growthKiB.toFixed(1)} KiB, handles ${handles0}→${handles1}`);
  expect(growthKiB).toBeLessThan(3 * 1024);
  expect(handles1).toBe(handles0);
  expect(mon.pending()).toBe(0);
  mon.clearAll();
  expect(handles()).toBe(handles0);
});

it("B1 monitor soak 全程 0 定时器", () => {
  vi.useFakeTimers();
  const mon = createMonitor();
  for (let i = 0; i < 1000; i++) {
    const j = job(`bg_${i}`);
    mon.watch(j, () => {});
    mon.__emitForTest(j.id, 0);
  }
  expect(vi.getTimerCount()).toBe(0);
  mon.clearAll();
});

it("B3 真实进程周期延迟基线（p50/p95/max）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-soak-"));
  const mon = createMonitor();
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = spawnJob({ command: "true", cwd: dir }, dir, Date.now());
    if (!r.ok) throw new Error(r.error);
    await new Promise<void>((resolve) => { mon.watch(r.job, () => resolve(), r.child); });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  const max = samples.at(-1)!;
  console.log(`spawn 周期: p50=${at(0.5).toFixed(1)}ms p95=${at(0.95).toFixed(1)}ms max=${max.toFixed(1)}ms`);
  expect(mon.pending()).toBe(0);
  expect(max).toBeLessThan(500);            // 宽松防退化；真实抖动画像见 console
});