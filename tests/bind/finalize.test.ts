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
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 4,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_q3kc0w8n}}")));
  boards = createBoardStore();
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "in_progress", inProgressSince: 0, jobs: ["R"] }];
  b.nextId = 2; boards.commit("S", b);
});

it("链未终结时不 finalize", () => {
  jobs.put(j("R", { status: "running", endedAt: null }));
  expect(finalizeChain("R", jobs, 10, "x", false)).toBe(false);
});

it("终结后 finalize 幂等，重复调用仍恰一条（F82）", () => {
  jobs.put(j("R"));
  expect(finalizeChain("R", jobs, 10, "4 次均失败", false)).toBe(true);
  expect(finalizeChain("R", jobs, 20, "again", false)).toBe(false);
  expect(jobs.get("R")?.finalResult?.note).toBe("4 次均失败");
});

it("投影产生唯一 chainFinal 证据（F87）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "S", 30)).toBe(true);
  const ev = boards.get("S").tasks[0].evidence ?? [];
  expect(ev.filter((e) => e.chainFinal)).toHaveLength(1);
  expect(ev[0].at).toBe(30);                       // R8-5：投影时刻
  expect(projectFinal("R", jobs, boards, "S", 40)).toBe(false);
});

it("evidence 环形溢出后仍不重复投影（F83）", () => {
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

it("别的会话不写 owner board（F84）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "OTHER", 30)).toBe(false);
  expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
});

it("trigger 从 sidecar 的 kill.requestedBy 读取（F81/F86）", () => {
  jobs.put(j("R", { status: "killed", kill: { requestedBy: "self", at: 5 } }));
  finalizeChain("R", jobs, 10, "killed", false);
  projectFinal("R", jobs, boards, "S", 30);
  expect(boards.get("S").tasks[0].evidence?.[0].trigger).toBe("self");
});

it("无 job 记录的终结路径也能合成证据（F77/F78）", () => {
  jobs.put(j("R", { status: "failed", retryAt: undefined }));
  const r = finalizeAndProject("R", jobs, boards, "S", 50, "spawn failed", false);
  expect(r.finalized).toBe(true);
  expect(r.projected).toBe(true);
  expect(boards.get("S").tasks[0].evidence?.[0].ref).toBe("R");
});

it("迟投影 at=now 不被 watermark 遮蔽（F91）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  const b = boards.get("S"); b.counters.wakeWatermark = 100; boards.commit("S", b);
  projectFinal("R", jobs, boards, "S", 200);
  expect(boards.get("S").tasks[0].evidence?.[0].at).toBe(200);
});
