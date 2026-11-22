import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { finalizeAndProject, finalizeChain, projectFinal } from "../../src/bind/finalize.js";
import { createBoardStore } from "../../src/board/store.js";
import { EVIDENCE_RING, emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

let jobs: ReturnType<typeof createJobStore>;
let boards: ReturnType<typeof createBoardStore>;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 6,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_q3kc0w8n}}")));
  boards = createBoardStore();
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "in_progress", inProgressSince: 0, jobs: ["R"] }];
  b.nextId = 2; boards.commit("S", b);
});

it("does not finalize while the chain is not terminated", () => {
  jobs.put(j("R", { status: "running", endedAt: null }));
  expect(finalizeChain("R", jobs, 10, "x", false)).toBe(false);
});

it("finalize is idempotent after termination and repeated calls still yield exactly one (F82)", () => {
  jobs.put(j("R"));
  expect(finalizeChain("R", jobs, 10, "failed after 6 attempts", false)).toBe(true);
  expect(finalizeChain("R", jobs, 20, "again", false)).toBe(false);
  expect(jobs.get("R")?.finalResult?.note).toBe("failed after 6 attempts");
});

it("projection produces a single chainFinal evidence (F87)", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "S", 30)).toBe(true);
  const ev = boards.get("S").tasks[0].evidence ?? [];
  expect(ev.filter((e) => e.chainFinal)).toHaveLength(1);
  expect(ev[0].at).toBe(30);                       // R8-5: projection time
  expect(projectFinal("R", jobs, boards, "S", 40)).toBe(false);
});

it("evidence ring overflow still does not project twice (F83)", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  projectFinal("R", jobs, boards, "S", 30);
  const b = boards.get("S");
  b.tasks[0].evidence = Array.from({ length: EVIDENCE_RING }, (_, i) => ({
    ok: true, kind: "job" as const, origin: "async" as const, chainFinal: false,
    at: 100 + i, known: true, fp: "fresh" as const,
  }));
  boards.commit("S", b);
  expect(projectFinal("R", jobs, boards, "S", 200)).toBe(false);
});

it("another session does not write the owner board (F84)", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "OTHER", 30)).toBe(false);
  expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
});

it("trigger is read from the sidecar's kill.requestedBy (F81/F86)", () => {
  jobs.put(j("R", { status: "killed", kill: { requestedBy: "self", at: 5 } }));
  finalizeChain("R", jobs, 10, "killed", false);
  projectFinal("R", jobs, boards, "S", 30);
  expect(boards.get("S").tasks[0].evidence?.[0].trigger).toBe("self");
});

it("a terminal path with no job record can still synthesize evidence (F77/F78)", () => {
  jobs.put(j("R", { status: "failed", retryAt: undefined }));
  const r = finalizeAndProject("R", jobs, boards, "S", 50, "spawn failed", false);
  expect(r.finalized).toBe(true);
  expect(r.projected).toBe(true);
  expect(boards.get("S").tasks[0].evidence?.[0].ref).toBe("R");
});

it("late projection at=now is not hidden by the watermark (F91)", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  const b = boards.get("S"); b.counters.wakeWatermark = 100; boards.commit("S", b);
  projectFinal("R", jobs, boards, "S", 200);
  expect(boards.get("S").tasks[0].evidence?.[0].at).toBe(200);
});

it("projection reads the last job's exit code/fingerprint (a successful retry must not show exit 1) (BLOCKER)", () => {
  jobs.put(j("R", { status: "failed", exitCode: 1, endedAt: 2 }));
  jobs.put(j("R2", { id: "R2", rootId: "R", retryOf: "R", status: "completed", exitCode: 0, endedAt: 10, fpVerdict: "fresh" }));
  finalizeChain("R", jobs, 20, "done", true);
  expect(jobs.get("R")?.finalResult?.jobId).toBe("R2");
  projectFinal("R", jobs, boards, "S", 30);
  const ev = boards.get("S").tasks[0].evidence?.[0];
  expect(ev?.exitCode).toBe(0);
  expect(ev?.fp).toBe("fresh");
});

it("a successful reverify produces a reverified note and projects fresh (BLOCKER)", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, endedAt: 2, fpVerdict: "stale" }));
  jobs.put(j("R2", { id: "R2", rootId: "R", retryOf: "R", staleReverifyOf: "R",
    status: "completed", exitCode: 0, endedAt: 10, fpVerdict: "fresh" }));
  finalizeChain("R", jobs, 20, "done", true);
  expect(jobs.get("R")?.finalResult?.note).toContain("reverified");
  projectFinal("R", jobs, boards, "S", 30);
  const ev = boards.get("S").tasks[0].evidence?.[0];
  expect(ev?.fp).toBe("fresh");
  expect(ev?.note).toContain("reverified");
});

it("F123 finalizeAndProject merges into one save and repeated calls save nothing (P2)", () => {
  jobs.put(j("R"));
  let saves = 0;
  const save = jobs.save.bind(jobs);
  jobs.save = () => { saves++; save(); };
  expect(finalizeAndProject("R", jobs, boards, "S", 50, "done", true)).toEqual({ finalized: true, projected: true });
  expect(saves).toBe(1);
  expect(finalizeAndProject("R", jobs, boards, "S", 60, "done", true)).toEqual({ finalized: false, projected: false });
  expect(saves).toBe(1);
});

it("same-millisecond termination uses the last job in chain write order (MAJOR #4)", () => {
  jobs.put(j("R", { status: "failed", exitCode: 1, endedAt: 2 }));
  jobs.put(j("R2", { id: "R2", rootId: "R", retryOf: "R", status: "completed", exitCode: 0, endedAt: 2, fpVerdict: "fresh" }));
  finalizeChain("R", jobs, 20, "done", true);
  expect(jobs.get("R")?.finalResult?.jobId).toBe("R2");
  projectFinal("R", jobs, boards, "S", 30);
  expect(boards.get("S").tasks[0].evidence?.[0].exitCode).toBe(0);
});
