import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnJob } from "../../src/jobs/spawn.js";
import { createMonitor } from "../../src/jobs/monitor.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-spawn-"));

it("记录 cwd 与 startStamp，退出码真实（F48 基础）", async () => {
  const d = dir();
  const r = spawnJob({ command: "pwd", cwd: d }, d, 1);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.job.cwd).toBe(d);
  expect(r.job.exitCodeKnown).toBe(false);   // 尚未退出
  expect(r.job.rootId).toBe(r.job.id);
  const mon = createMonitor();
  const code = await new Promise<number | null>((res) => mon.watch(r.job, (j) => res(j.exitCode)));
  expect(code).toBe(0);
  expect(readFileSync(r.job.logPath, "utf8").trim()).toBe(d);
  mon.clearAll();
});

it("失败命令得到非零真实退出码", async () => {
  const d = dir();
  const r = spawnJob({ command: "exit 7", cwd: d }, d, 1);
  if (!r.ok) throw new Error(r.error);
  const mon = createMonitor();
  const j = await new Promise<typeof r.job>((res) => mon.watch(r.job, res));
  expect(j.exitCode).toBe(7);
  expect(j.exitCodeKnown).toBe(true);
  expect(j.status).toBe("failed");
  mon.clearAll();
});

it("空命令直接失败，不产生 job", () => {
  const d = dir();
  expect(spawnJob({ command: "   ", cwd: d }, d, 1).ok).toBe(false);
});

it("fpStart 由调用方在 spawn 前采集并原样记录（BLOCKER）", () => {
  const d = dir();
  const r = spawnJob({ command: "true", cwd: d, fpStart: "PRE-SPAWN" }, d, 1);
  if (!r.ok) throw new Error(r.error);
  expect(r.job.fpStart).toBe("PRE-SPAWN");
});

it("无效 cwd 只返回错误，不产生未处理 error 事件（BLOCKER）", async () => {
  const d = dir();
  const r = spawnJob({ command: "true", cwd: "/nonexistent-vigil-cwd" }, d, 1);
  expect(r.ok).toBe(false);
  await new Promise((res) => setTimeout(res, 50));
});
