import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import type { RuleContext } from "../../src/board/invariants.js";
import type { Job } from "../../src/jobs/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { createBgKillTool, createBgRunTool, type ToolDeps } from "../../src/tool/register.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});
const deps = (board: ReturnType<typeof emptyBoard>, jobs: ReturnType<typeof createJobStore>, over: Partial<ToolDeps> = {}): ToolDeps => ({
  sessionId: () => "S", cwd: () => "/tmp", board: () => board, commit: () => {}, appendEntry: () => {},
  ruleCtx: ctx, jobs, cfg: DEFAULTS, spawn: () => ({ ok: true, jobId: "bg_x" }), kill: () => {},
  runVerify: async () => ({ ok: true, exitCode: 0 }), now: () => 1, ...over,
});

it("bg_run: rejects empty/oversized/NUL commands, oversized and non-string labels, and invalid task_id", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-edge-")));
  const tool = createBgRunTool(deps(b, jobs));
  expect((await tool.execute({ command: "   " })).content[0].text).toContain("Command cannot be empty");
  expect((await tool.execute({ command: "x".repeat(100_001) })).content[0].text).toContain("too long");
  expect((await tool.execute({ command: "a\u0000b" })).content[0].text).toContain("NUL");
  expect((await tool.execute({ command: "true", label: "x".repeat(501) })).content[0].text).toContain("label too long");
  expect((await tool.execute({ command: "true", label: 7 as never })).content[0].text).toContain("label must be a string");
  expect((await tool.execute({ command: "true", task_id: Number.NaN })).content[0].text).toContain("safe integer");
  expect((await tool.execute({ command: "true", task_id: Number.MAX_SAFE_INTEGER + 1 })).content[0].text).toContain("safe integer");
});

it("bg_run: rejects a task_id that points to a deleted task", async () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "deleted" }];
  b.nextId = 2;
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-edge-")));
  const r = await createBgRunTool(deps(b, jobs)).execute({ command: "true", task_id: 1 });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("deleted");
});

it("bg_kill: empty/nonexistent/terminal/repeated kill", async () => {
  const b = emptyBoard();
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-edge-")));
  const tool = createBgKillTool(deps(b, jobs, {
    kill: (id, by) => {
      const j = jobs.get(id);
      if (j) jobs.put({ ...j, kill: { requestedBy: by, at: 1 } });
    },
  }));
  for (const id of ["", "   "]) {
    expect((await tool.execute({ job_id: id })).content[0].text).toContain("job_id required");
  }
  expect((await tool.execute({ job_id: "nope" })).content[0].text).toContain("not found");

  jobs.put(job("done", { status: "completed", exitCode: 0 }));
  expect((await tool.execute({ job_id: "done" })).content[0].text).toContain("nothing to abort");

  jobs.put(job("run", { status: "running", endedAt: null, exitCode: null, exitCodeKnown: false }));
  expect((await tool.execute({ job_id: "run" })).content[0].text).toContain("Killed");
  expect((await tool.execute({ job_id: "run" })).content[0].text).toContain("already requested");
});
