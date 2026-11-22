import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import type { RuleContext } from "../../src/board/invariants.js";
import type { Job } from "../../src/jobs/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { buildResult } from "../../src/tool/envelope.js";
import { createBgKillTool, createBgListTool, type ToolDeps } from "../../src/tool/register.js";
import { composeWake } from "../../src/wake/compose.js";
import { layoutRows, renderDoctor, renderTodos } from "../../src/ui/panel.js";

const EVIL = "\u001b]0;pwned\u0007\u001b[31mRED";

const board = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const blank = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-sec-")));
const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});
const job = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "r", command: "true", logPath: "/tmp/none.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1, taskId: 1, sessionId: "S",
  evidenceApplied: false, notifyState: "pending", ...o,
});
const deps = (jobs: ReturnType<typeof blank>, state = emptyBoard()): ToolDeps => ({
  sessionId: () => "S", cwd: () => "/tmp", board: () => state, commit: () => {}, appendEntry: () => {},
  ruleCtx: ctx, jobs, cfg: DEFAULTS,
  spawn: () => ({ ok: true }), kill: () => {},
  runVerify: async () => ({ ok: false, exitCode: null }), now: () => 1,
});

const expectClean = (out: string): void => {
  expect(out).not.toContain("\u001b");
  expect(out).not.toContain("\u0007");
  expect(out).toContain("RED");
};

const cases: [string, () => string | Promise<string>][] = [
  ["面板 pending subject", () => {
    const s = board([{ id: 1, subject: EVIL, status: "pending" }]);
    return layoutRows(s, blank(), 12).rows.join("\n");
  }],
  ["面板 parked reason", () => {
    const s = board([{ id: 1, subject: "p", status: "parked", park: { reason: EVIL, at: 1, from: "pending" } }]);
    return layoutRows(s, blank(), 12).rows.join("\n");
  }],
  ["面板 in_progress subject/activeForm", () => {
    const s = board([{ id: 1, subject: EVIL, status: "in_progress", activeForm: EVIL }]);
    return layoutRows(s, blank(), 12).rows.join("\n");
  }],
  ["/todos subject", () => {
    const s = board([{ id: 1, subject: EVIL, status: "completed" }]);
    return renderTodos(s, blank());
  }],
  ["/todos park reason", () => {
    const s = board([{ id: 1, subject: "p", status: "parked", park: { reason: EVIL, at: 1, from: "pending" } }]);
    return renderTodos(s, blank());
  }],
  ["doctor degraded 文案", () => renderDoctor(emptyBoard(), blank(), false, EVIL)],
  ["唤醒消息 label/note/日志尾/next", () => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-sec-wake-"));
    const log = join(dir, "x.log");
    writeFileSync(log, `${EVIL} log`);
    const jobs = createJobStore(dir);
    jobs.put(job({ label: EVIL, logPath: log, status: "failed", exitCode: 1,
      finalResult: { ok: false, note: EVIL, trigger: "external", at: 2, jobId: "R" } }));
    const b = board([{ id: 1, subject: EVIL, status: "pending" }]);
    return composeWake(["R"], b, jobs, DEFAULTS, b.tasks[0]);
  }],
  ["todo list 结果文本", () => {
    const s = board([{ id: 1, subject: EVIL, status: "pending" }]);
    return buildResult({ action: "list" }, s, { kind: "list" }).content[0].text;
  }],
  ["todo delete 结果文本", () => {
    const s = board([{ id: 1, subject: EVIL, status: "pending" }]);
    return buildResult({ action: "delete", id: 1 }, s, { kind: "delete", id: 1, subject: EVIL }).content[0].text;
  }],
  ["bg_list label/command", async () => {
    const jobs = blank();
    jobs.put(job({ id: "R", label: EVIL, command: EVIL }));
    return (await createBgListTool(deps(jobs)).execute({})).content[0].text;
  }],
  ["bg_kill 结果中的 id/链", async () => {
    const jobs = blank();
    jobs.put(job({ id: EVIL, rootId: EVIL }));
    return (await createBgKillTool(deps(jobs)).execute({ job_id: EVIL })).content[0].text;
  }],
];

it.each(cases)("恶意控制字符不进入终端输出：%s", async (_name, render) => {
  expectClean(await render());
});
