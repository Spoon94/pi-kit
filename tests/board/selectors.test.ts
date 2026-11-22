import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Evidence, type Task } from "../../src/board/types.js";
import { completedSummary, selectNext, wipCount } from "../../src/board/selectors.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-sel-")));
const final = (ok: boolean, reverified?: boolean, note = "done") =>
  ({ ok, note, trigger: "external" as const, at: 2, jobId: undefined, reverified });
const root = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1, taskId: 1, sessionId: "S",
  evidenceApplied: true, finalized: true, notifyState: "acked", ...o,
});
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp: "fresh",
  ref: "R", exitCode: 0, ...o,
});

it("next is empty when WIP is full or capacity is full (F40)", () => {
  const s = b([t(1, { status: "in_progress" }), t(2)]);
  expect(selectNext(s, 1, false)).toBeUndefined();
  expect(selectNext(s, 3, true)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(2);
});

it("skips parked / unmet dependencies, ordered by ascending id (F19)", () => {
  const s = b([
    t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }),
    t(3, { blockedBy: [1] }),
    t(4),
  ]);
  expect(selectNext(s, 1, false)?.id).toBe(4);
  expect(wipCount(s)).toBe(0);
});

it("completed summary reads fp:? and reverified from job-side finals (F58)", () => {
  const jobs = store();
  jobs.put(root("R1", { finalResult: final(true, false) }));
  jobs.put(root("R2", { finalResult: final(true, false), fpVerdict: "unknown" }));
  jobs.put(root("R3", { finalResult: final(true, true) }));
  const s = b([
    t(1, { status: "completed", jobs: ["R1"] }),
    t(2, { status: "completed", jobs: ["R2"] }),
    t(3, { status: "completed", jobs: ["R3"] }),
    t(4),
  ]);
  expect(completedSummary(s, jobs)).toMatchObject({ done: 3, total: 4, allExit0: true, fpUnknown: 1, reverified: 1 });
});

it("B1 allExit0 is false when a failure chainFinal was evicted but the job-side failure remains", () => {
  const jobs = store();
  jobs.put(root("fail", { status: "failed", exitCode: 1, finalResult: final(false) }));
  jobs.put(root("ok", { finalResult: final(true) }));
  const task = t(1, {
    status: "completed", jobs: ["fail", "ok"],
    lastFailure: { exitCode: 1, ref: "fail", at: 2 },
    evidence: [ev({ ref: "ok" })],                    // the failure chainFinal was rolled out
  });
  const sum = completedSummary(b([task]), jobs);
  expect(sum.allExit0).toBe(false);                   // old code said true from the surviving final
  expect(sum.evidenceRolled).toBe(false);
});

it("B1 handles lastFailure-only / missing root records conservatively", () => {
  const jobs = store();
  const onlyLastFailure = t(1, { status: "completed", lastFailure: { exitCode: 1, ref: "R", at: 1 } });
  const sum = completedSummary(b([onlyLastFailure]), jobs);
  expect(sum.allExit0).toBe(false);
  expect(sum.evidenceRolled).toBe(false);

  jobs.put(root("child", { id: "child", rootId: "R", taskId: 2, finalResult: final(true) }));   // root record itself is gone
  const child = t(2, { status: "completed", jobs: ["child"] });
  expect(completedSummary(b([child]), jobs).allExit0).toBe(true);
});

it("B1 a bound root without finalResult is not reported as exit 0", () => {
  const jobs = store();
  jobs.put(root("R", { finalResult: undefined }));
  expect(completedSummary(b([t(1, { status: "completed", jobs: ["R"] })]), jobs).allExit0).toBe(false);
});

it("B1 terminal fp follows finalResult.jobId when that job still exists", () => {
  const jobs = store();
  jobs.put(root("R", { finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: "R2" } }));
  jobs.put(root("R2", { id: "R2", rootId: "R", fpVerdict: "unknown", finalResult: undefined }));
  expect(completedSummary(b([t(1, { status: "completed", jobs: ["R"] })]), jobs).fpUnknown).toBe(1);
});

it("B1 evidence fallback with a failed final is not exit 0", () => {
  const s = b([t(1, {
    status: "completed", jobs: ["gone"],
    evidence: [ev({ ok: false, exitCode: 1, ref: "gone" })],
  })]);
  const sum = completedSummary(s, store());
  expect(sum.allExit0).toBe(false);
  expect(sum.evidenceRolled).toBe(true);
});

it("B1 falls back to evidence only after job records are gone and flags evidenceRolled", () => {
  const jobs = store();
  const okTask = t(1, { status: "completed", jobs: ["gone"], evidence: [ev({ ref: "gone" })] });
  const ok = completedSummary(b([okTask]), jobs);
  expect(ok.allExit0).toBe(true);
  expect(ok.evidenceRolled).toBe(true);

  const noTrace = t(2, { status: "completed", jobs: ["gone"] });
  const bad = completedSummary(b([noTrace]), jobs);
  expect(bad.allExit0).toBe(false);
  expect(bad.evidenceRolled).toBe(true);
});

it("does not falsely report all exit 0 when chainFinal is evicted by the ring (MINOR #3)", () => {
  const evidence = Array.from({ length: 8 }, (_, i) => ev({
    ok: false, chainFinal: false, at: i, fp: "fresh", exitCode: 1, ref: `bg_${i}`,
  }));
  const s = b([t(1, { status: "completed", jobs: ["bg_a"], evidence })]);
  const sum = completedSummary(s, store());
  expect(sum.allExit0).toBe(false);
  expect(sum.evidenceRolled).toBe(true);
});

it("B2 reverified counts the explicit marker, never note text", () => {
  const jobs = store();
  jobs.put(root("R1", { finalResult: final(true, false, "reverified · done") }));  // decoy note
  jobs.put(root("R2", { finalResult: final(true, true, "completed") }));          // marker only
  const byJob = completedSummary(b([t(1, { status: "completed", jobs: ["R1", "R2"] })]), jobs);
  expect(byJob.reverified).toBe(1);

  const empty = store();
  const decoy = b([t(2, {
    status: "completed", jobs: ["gone"],
    evidence: [ev({ ref: "gone", note: "reverified", reverified: false })],
  })]);
  expect(completedSummary(decoy, empty).reverified).toBe(0);

  const marked = b([t(3, {
    status: "completed", jobs: ["gone"],
    evidence: [ev({ ref: "gone", note: "all good", reverified: true })],
  })]);
  expect(completedSummary(marked, store()).reverified).toBe(1);
});
