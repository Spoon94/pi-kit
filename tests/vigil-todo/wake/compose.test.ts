import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import { composeWake } from "../../../src/vigil-todo/wake/compose.js";

const j = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "regression", command: "npm test", logPath: "/tmp/none.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending",
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, ...o,
});

it("success message includes the real call shape and next", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"))); jobs.put(j());
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "regression", status: "completed" }, { id: 2, subject: "cleanup", status: "pending" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, b.tasks[1]);
  expect(text).toContain("[vigil-todo]");
  expect(text).toContain("next: #2");
  expect(text).toContain('bg_run({task_id:2');
  expect(text).toContain('status:"parked"');
});

it("failure message includes the log tail (F72)", () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const log = join(d, "f.log");
  writeFileSync(log, Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n"));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log, finalResult: { ok: false, note: "all 6 attempts failed", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("L49");
  expect(text).not.toContain("L0\n");
});

it("exhausted stale offers both the accept/verify paths (F20)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ fpVerdict: "stale", finalResult: { ok: false, note: "workspace kept changing; evidence could not be confirmed", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain('accept:"stale"');
  expect(text).toContain('action:"verify"');
});

it("message length is bounded (≈≤1200 tokens: character cap)", () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const log = join(d, "big.log");
  writeFileSync(log, "x".repeat(100_000));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "parked" }];
  expect(composeWake(["R"], b, jobs, DEFAULTS, undefined).length).toBeLessThan(4800);
});

it("message reads the last job, not the root (a successful retry does not show exit 1) (BLOCKER)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ id: "R", exitCode: 1, fpVerdict: "stale",
    finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: "R2" } }));
  jobs.put(j({ id: "R2", rootId: "R", exitCode: 0, fpVerdict: "fresh", label: "second attempt" }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "completed" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("exit 0");
  expect(text).toContain("fp:fresh");
  expect(text).not.toContain("exit 1");
});

it("success message includes job elapsed time (§7.5)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ startedAt: 1_000, endedAt: 1_000 + 192_000 }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "completed" }];
  expect(composeWake(["R"], b, jobs, DEFAULTS, undefined)).toContain("3m12s");
});

it("out-of-bounds logPath is not read, preventing exfiltration via sidecar tampering (MINOR #2)", () => {
  const root = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "TOPSECRET");
  const jobs = createJobStore(join(root, "store"));
  jobs.put(j({
    logPath: secret, status: "failed", exitCode: 1,
    finalResult: { ok: false, note: "failed", trigger: "external", at: 2, jobId: "R" },
  }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "regression", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).not.toContain("TOPSECRET");
  expect(text).not.toContain("log tail");
});

it("P1 core status overflow stops before logs and reports unexpanded chains", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `R${i}`;
    ids.push(id);
    jobs.put(j({
      id, rootId: id, label: "x".repeat(400), status: "failed", exitCode: 1,
      finalResult: { ok: false, note: "failed", trigger: "external", at: 2 },
    }));
  }
  const text = composeWake(ids, emptyBoard(), jobs, DEFAULTS, undefined);
  expect(text.length).toBeLessThanOrEqual(4800);
  expect(text).toContain("chains not fully expanded");
});

it("P1 a missing terminal job falls back to the root log and an empty log has no tail header", () => {
  const d = mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}"));
  const log = join(d, "f.log");
  writeFileSync(log, "tail line");
  const jobs = createJobStore(d);
  jobs.put(j({
    logPath: log, status: "failed", exitCode: 1,
    finalResult: { ok: false, note: "failed", trigger: "external", at: 2, jobId: "GONE" },
  }));
  expect(composeWake(["R"], emptyBoard(), jobs, DEFAULTS, undefined)).toContain("log tail");

  const emptyLog = join(d, "empty.log");
  writeFileSync(emptyLog, "");
  jobs.put(j({
    logPath: emptyLog, status: "failed", exitCode: 1,
    finalResult: { ok: false, note: "failed", trigger: "external", at: 2 },
  }));
  const text = composeWake(["R"], emptyBoard(), jobs, DEFAULTS, undefined);
  expect(text).not.toContain("log tail");
});

it("tolerates a missing root and default fields", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9q0d6s1e}}")));
  jobs.put(j({ taskId: undefined, exitCode: null, endedAt: null, finalResult: undefined }));
  const text = composeWake(["R", "missing"], emptyBoard(), jobs, DEFAULTS, undefined);
  expect(text).toContain("#?");
  expect(text).toContain("exit ?");
  expect(text).toContain("No actionable tasks");
});

it("F163 wake messages keep the exact elapsed form (3m12s), coarse display does not leak in", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-compose-"));
  const log = join(dir, "r.log");
  writeFileSync(log, "ok");
  const jobs = createJobStore(dir);
  jobs.put({
    id: "R", rootId: "R", label: "r", command: "x", logPath: log, cwd: "/tmp", pid: 1,
    status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1_000, endedAt: 193_000,
    fpVerdict: "fresh", interferers: [], attempt: 1, taskId: 1, sessionId: "S",
    evidenceApplied: true, finalized: true, notifyState: "pending",
    finalResult: { ok: false, note: "failed", trigger: "external", at: 2, jobId: "R" },
  } as never);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "failed" as never }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("3m12s");
  expect(text).not.toContain("3m ");
});
