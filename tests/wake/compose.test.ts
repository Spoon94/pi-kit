import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { composeWake } from "../../src/wake/compose.js";

const j = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "回归", command: "npm test", logPath: "/tmp/none.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending",
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, ...o,
});

it("成功消息含真实调用形态与 next", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"))); jobs.put(j());
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "回归", status: "completed" }, { id: 2, subject: "清理", status: "pending" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, b.tasks[1]);
  expect(text).toContain("[vigil-todo]");
  expect(text).toContain("next: #2");
  expect(text).toContain('bg_run({task_id:2');
  expect(text).toContain('status:"parked"');
});

it("失败消息附日志尾（F72）", () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const log = join(d, "f.log");
  writeFileSync(log, Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n"));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log, finalResult: { ok: false, note: "4 次均失败", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("L49");
  expect(text).not.toContain("L0\n");
});

it("stale 用尽给 accept/verify 两条路（F20）", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ fpVerdict: "stale", finalResult: { ok: false, note: "工作区持续变动，证据无法确认", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain('accept:"stale"');
  expect(text).toContain('action:"verify"');
});

it("消息长度受控（≤1200 token 近似：字符上限）", () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const log = join(d, "big.log");
  writeFileSync(log, "x".repeat(100_000));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  expect(composeWake(["R"], b, jobs, DEFAULTS, undefined).length).toBeLessThan(4800);
});

it("消息读末次 job 而非 root（重试成功不显示 exit 1）（BLOCKER）", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ id: "R", exitCode: 1, fpVerdict: "stale",
    finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: "R2" } }));
  jobs.put(j({ id: "R2", rootId: "R", exitCode: 0, fpVerdict: "fresh", label: "第二次" }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "completed" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("exit 0");
  expect(text).toContain("fp:fresh");
  expect(text).not.toContain("exit 1");
});
