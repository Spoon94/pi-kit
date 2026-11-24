import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Evidence, type Task } from "../../../src/vigil-todo/board/types.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import { layoutRows, renderDoctor, renderPanel, renderStatus, renderTodos } from "../../../src/vigil-todo/ui/panel.js";

const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp: "fresh", exitCode: 0, ref: "R", ...o,
});
const done = (id: number, fp: "fresh" | "unknown" = "fresh"): Task =>
  ({ id, subject: `d${id}`, status: "completed", evidence: [ev({ fp, ref: `R${id}` })] });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const jobs = () => createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_z8p3x1cq}}")));
const root = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1, taskId: 1, sessionId: "S",
  evidenceApplied: true, finalized: true, notifyState: "acked",
  finalResult: { ok: true, note: "done", trigger: "external", at: 2, reverified: false }, ...o,
});
const finals = (...roots: Job[]) => {
  const s = jobs();
  for (const r of roots) s.put(r);
  return s;
};

it("first line includes done/total and the parked count (F25)", () => {
  const s = b([done(1), { id: 2, subject: "p", status: "parked", park: { reason: "needs a decision", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows[0]).toContain("1/2");
  expect(rows[0]).toContain("1 parked");
});

it("completed summary line includes job-side evidence and the fp:? count (F58)", () => {
  const s = b([
    { ...done(1), jobs: ["R1"] },
    { ...done(2, "unknown"), jobs: ["R2"] },
    { ...done(3, "unknown"), jobs: ["R3"] },
  ]);
  const jj = finals(
    root("R1", { taskId: 1 }),
    root("R2", { taskId: 2, fpVerdict: "unknown" }),
    root("R3", { taskId: 3, fpVerdict: "unknown" }),
  );
  const rows = renderPanel(s, jj, DEFAULTS);
  const summary = rows.find((r) => r.includes("done ·"));
  expect(summary).toContain("3 done");
  expect(summary).toContain("all exit 0");
  expect(summary).toContain("2 with fp:?");
});

it("parked reason occupies its own indented line (F25)", () => {
  const s = b([{ id: 1, subject: "p", status: "parked", park: { reason: "public API needs a decision", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows.some((r) => r.includes("└─ public API needs a decision"))).toBe(true);
});

it("over budget preserves parked first; truncation shows +N more parked (F25)", () => {
  const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, subject: `p${i}`, status: "parked" as const, park: { reason: `r${i}`, at: 1, from: "pending" as const },
  }));
  const r = layoutRows(b(tasks), jobs(), 6);
  expect(r.hiddenParked).toBeGreaterThan(0);
  expect(r.rows.join("\n")).toContain("more parked");
  expect(r.rows[0]).toContain("10 parked");
});

it("empty list returns an empty array (auto-unload)", () => {
  expect(renderPanel(emptyBoard(), jobs(), DEFAULTS)).toEqual([]);
});

it("C2 status line: progress / running jobs / parked / halted / cleared when empty", () => {
  const empty = jobs();
  expect(renderStatus(emptyBoard(), empty)).toBeUndefined();

  const progress = b([done(1), { id: 2, subject: "p", status: "pending" }]);
  expect(renderStatus(progress, empty)).toBe("vigil ✓ 1/2");

  const parked = b([{ id: 1, subject: "p", status: "parked", park: { reason: "r", at: 1, from: "pending" } }]);
  expect(renderStatus(parked, empty)).toBe("vigil ⚠ 1 parked");

  const halted = { ...progress, counters: { ...progress.counters, halted: true } };
  expect(renderStatus(halted, empty)).toBe("vigil ⏸ halted");

  const running = jobs();
  running.put({
    id: "bg_x", label: "x", command: "true", logPath: "/tmp/x.log", cwd: "/tmp", pid: 1,
    status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
    fpVerdict: "unknown", interferers: [], rootId: "bg_x", attempt: 1,
    evidenceApplied: false, notifyState: "pending",
  });
  expect(renderStatus(progress, running)).toBe("vigil ● 1 job");
});

it("/todos lists each task with exit code and fp (F58 drill-down)", () => {
  const text = renderTodos(b([done(1), done(2, "unknown")]), jobs());
  expect(text).toContain("#1");
  expect(text).toContain("exit 0");
  expect(text).toContain("fp:unknown");
});

it("doctor reports conflict and degradation (F13/F12)", () => {
  const text = renderDoctor(emptyBoard(), jobs(), true, "sidecar corrupted");
  expect(text).toContain("todo tool conflict");
  expect(text).toContain("sidecar corrupted");
});

it("doctor reports halted / purged / overdue / orphan jobs, each with an actionable next step", () => {
  const b = emptyBoard();
  b.counters.halted = true;
  b.tasks = [{ id: 1, subject: "old", status: "completed", statusSince: 1 }];
  const text = renderDoctor(b, jobs(), false, undefined, { purgedRoots: 2, retentionOverdue: 1, orphanJobs: 3 });
  expect(text).toContain("Halted → /vigil-todo resume to resume");
  expect(text).toContain("2 chains purged");
  expect(text).toContain("no action needed");
  expect(text).toContain("create a new task to rerun");
  expect(text).toContain("overdue for cleanup");
  expect(text).toContain("/vt clear to clear history (terminal only)");
  expect(text).toContain("orphan jobs");
  expect(text).toContain("bg_list to inspect");
  expect(text).toContain('bg_kill({job_id:"…"}) to reclaim');
});

it("doctor: in_progress without a bound job gives a verify next step and the specific task id", () => {
  const s = b([
    { id: 7, subject: "a", status: "in_progress" },
    { id: 9, subject: "b", status: "in_progress" },
  ]);
  const text = renderDoctor(s, jobs(), false, undefined,
    { purgedRoots: 0, retentionOverdue: 0, orphanJobs: 0 });
  expect(text).toContain("2 in_progress tasks have no bound job");
  expect(text).toContain("e.g. #7");
  expect(text).toContain('todo({action:"verify", id:7})');
  expect(text).toContain("or start a job");
});

it("turn limit reached is marked on the panel's first line and in doctor (F24)", () => {
  const s = b([{ id: 1, subject: "p", status: "pending" }]);
  s.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(renderPanel(s, jobs(), DEFAULTS)[0]).toContain("turn limit reached");
  expect(renderDoctor(s, jobs(), false)).toContain("Turn limit reached");
});

it("in_progress row shows ✶ elapsed; retry limit follows config (§8.1)", () => {
  const now = 1_000_000;
  const s = b([{ id: 1, subject: "add unit tests", status: "in_progress", activeForm: "writing tests" }]);
  const jj = jobs();
  const running: Job = {
    id: "bg_x", label: "x", command: "true", logPath: "/tmp/x.log", cwd: "/tmp", pid: 1,
    status: "running", exitCode: null, exitCodeKnown: false, startedAt: now - 130_000, endedAt: null,
    fpVerdict: "unknown", interferers: [], rootId: "bg_x", attempt: 1, taskId: 1, sessionId: "S",
    evidenceApplied: false, notifyState: "pending",
  };
  jj.put(running);
  const { rows } = layoutRows(s, jj, 12, DEFAULTS, now);
  const line = rows.find((r) => r.includes("#1")) ?? "";
  expect(line).toContain("✶ 2m10s");
  expect(line).toContain("retry 1/6");                 // default total attempts is 6
  const custom = layoutRows(s, jj, 12, { ...DEFAULTS, retries: 1 }, now);
  expect(custom.rows.find((r) => r.includes("#1")) ?? "").toContain("retry 1/2");
});

it("summary does not show all exit 0 when evidence rolled (MINOR #3)", () => {
  const evidence: Evidence[] = Array.from({ length: 8 }, (_, i) => ({
    ok: false, kind: "job", origin: "async", chainFinal: false,
    at: i, known: true, fp: "fresh", exitCode: 1, ref: `bg_${i}`,
  }));
  const s = b([{ id: 1, subject: "d", status: "completed", jobs: ["bg_a"], evidence }]);
  const summary = renderPanel(s, jobs(), DEFAULTS).find((r) => r.includes("done ·")) ?? "";
  expect(summary).toContain("evidence rolled");
  expect(summary).not.toContain("all exit 0");
});

it("WIP oversold is visible in the panel and doctor (MINOR #5)", () => {
  const tasks: Task[] = [
    { id: 1, subject: "i1", status: "in_progress" },
    { id: 2, subject: "i2", status: "in_progress" },
    { id: 3, subject: "i3", status: "in_progress" },
    { id: 4, subject: "p", status: "pending" },
  ];
  const s = b(tasks);
  expect(renderPanel(s, jobs(), { ...DEFAULTS, wipLimit: 1 })[0]).toContain("WIP oversold (3/1)");
  const doc = renderDoctor(s, jobs(), false, undefined,
    { purgedRoots: 0, retentionOverdue: 0, orphanJobs: 0, wipLimit: 1 });
  expect(doc).toContain("exceeds wipLimit=1");
  expect(doc).not.toContain("nothing actionable");
});

it("panel truncates to width with an ellipsis; /todos is not truncated (F115)", () => {
  const long = "x".repeat(300);
  const s = b([
    { id: 1, subject: long, status: "pending" },
    { id: 2, subject: "p", status: "parked", park: { reason: long, at: 1, from: "pending" } },
  ]);
  const rows = renderPanel(s, jobs(), DEFAULTS).filter((r) => r !== "");
  for (const r of rows) expect(Array.from(r).length).toBeLessThanOrEqual(100);
  expect(rows.join("\n")).toContain("…");

  const narrow = layoutRows(s, jobs(), 12, DEFAULTS, 1, 60).rows;
  for (const r of narrow) expect(Array.from(r).length).toBeLessThanOrEqual(60);

  expect(renderTodos(s, jobs())).toContain(long);
});

it("summary line covers nonzero exit / reverified / verify changed branches", () => {
  const s = b([
    { id: 1, subject: "a", status: "completed", verifyChanged: true, jobs: ["R1"] },
    { id: 2, subject: "b", status: "completed", jobs: ["R2"] },
  ]);
  const jj = finals(
    root("R1", { taskId: 1, status: "failed", exitCode: 1, finalResult: { ok: false, note: "exit 1", trigger: "external", at: 2 } }),
    root("R2", { taskId: 2, finalResult: { ok: true, note: "done", trigger: "external", at: 2, reverified: true } }),
  );
  const summary = renderPanel(s, jj, DEFAULTS).find((r) => r.includes("done ·")) ?? "";
  expect(summary).toContain("nonzero exit");
  expect(summary).toContain("reverified");
  expect(summary).toContain("verify changed");
});

it("parked without reason, budget truncation, and renderTodos empty-evidence branch", () => {
  const parked = b([{ id: 1, subject: "p", status: "parked" }]);
  expect(renderPanel(parked, jobs(), DEFAULTS).some((r) => r.includes("└─"))).toBe(true);

  const many: Task[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: i + 1, subject: `i${i}`, status: "in_progress" as const })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: i + 5, subject: `p${i}`, status: "pending" as const })),
  ];
  const { rows } = layoutRows(b(many), jobs(), 3);
  expect(rows).toHaveLength(3);

  const doneNoFin = b([{ id: 1, subject: "a", status: "completed" }]);
  expect(renderTodos(doneNoFin, jobs())).toContain("[completed] #1 a");
  expect(renderTodos(emptyBoard(), jobs())).toBe("No tasks");
});

it("F169 doctor flags in_progress tasks that already have passing evidence", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-doc-")));
  jobs.put({
    id: "bg_ok", rootId: "bg_ok", label: "ok", command: "true", logPath: "/tmp/x", cwd: "/tmp",
    pid: 1, status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 5000, endedAt: 5001,
    fpVerdict: "fresh", interferers: [], attempt: 1, taskId: 1, sessionId: "S",
    evidenceApplied: true, finalized: true, notifyState: "pending",
  } as never);
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "stuck", status: "in_progress", inProgressSince: 5000, jobs: ["bg_ok"],
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 5001,
      known: true, fp: "fresh", exitCode: 0, ref: "bg_ok" }],
  } as never];
  b.nextId = 2;
  const doc = renderDoctor(b, jobs, false);
  expect(doc).toContain("passing evidence but were not completed");
  expect(doc).toContain('todo({action:"update", id:1, status:"completed"})');

  const clean = emptyBoard();
  clean.tasks = [{ id: 1, subject: "fine", status: "in_progress", inProgressSince: 5000, jobs: ["bg_ok"] }];
  clean.nextId = 2;
  expect(renderDoctor(clean, jobs, false)).not.toContain("passing evidence");
});
