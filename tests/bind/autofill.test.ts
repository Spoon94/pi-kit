import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autofillJob, type AutofillDeps } from "../../src/bind/autofill.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let deps: AutofillDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
const task = (o: Partial<Task> = {}): Task => ({ id: 1, subject: "t", status: "in_progress", inProgressSince: 50, jobs: ["A"], ...o });
const job = (o: Partial<Job> = {}): Job => ({
  id: "A", label: "a", command: "npm test", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 100, endedAt: 200,
  fpStart: "X", fpEnd: "X", fpVerdict: "unknown", interferers: [],
  rootId: "A", attempt: 1, taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_dzs7b2he}}")));
  const b = emptyBoard(); b.tasks = [task()]; b.nextId = 2; boards.commit("S", b);
  deps = { boards, jobs, cfg: DEFAULTS, now: 300, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {} };
});

describe("成功路径", () => {
  it("fresh + 证据合格 → 自动 completed（F4）", () => {
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("completed");
    expect(boards.get("S").tasks[0].status).toBe("completed");
  });
  it("unknown 也自动完成（F58）", () => {
    jobs.put(job({ fpEnd: "Y", interferers: ["B"] }));
    jobs.put(job({ id: "B", taskId: 2, rootId: "B", startedAt: 150, endedAt: 250, fpStart: "X", fpEnd: "Z" }));
    expect(autofillJob("A", deps).action).toBe("completed");
  });
  it("重复调用只写一条证据（F31）", () => {
    jobs.put(job());
    autofillJob("A", deps); autofillJob("A", deps);
    expect(boards.get("S").tasks[0].evidence).toHaveLength(1);
  });
});

describe("stale 自动重验", () => {
  it("首次 stale 触发重验，不 park 不完成（F64）", () => {
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("reverify");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
    expect(jobs.get("A")?.pendingReverify).toBe(true);
  });
  it("有 verify.command 时重验跑它（F68）", () => {
    const b = boards.get("S"); b.tasks[0].verify = { kind: "command", command: "npm run check" }; boards.commit("S", b);
    let cmd = "";
    deps.respawn = (req) => { cmd = req.command; return { ok: true }; };
    jobs.put(job({ fpEnd: "Y" }));
    autofillJob("A", deps);
    expect(cmd).toBe("npm run check");
  });
  it("重验额度用尽 → parked（F20）", () => {
    jobs.put(job({ fpEnd: "Y" }));
    jobs.put(job({ id: "R1", rootId: "A", retryOf: "A", staleReverifyOf: "A", fpEnd: "Z" }));
    expect(autofillJob("A", { ...deps, now: 400 }).action).toBe("parked");
  });
  it("重验遇 capacity 拒 → parked（F69）", () => {
    deps.respawn = () => ({ ok: false, error: "capacity" });
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("parked");
    expect(r.reason).toContain("槽位");
  });
  it("verifyChanged 的任务禁止自动完成（F53）", () => {
    const b = boards.get("S"); b.tasks[0].verifyChanged = true; boards.commit("S", b);
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
  });
});

describe("失败与终结", () => {
  it("失败未用尽 → retry 且写 lastFailure（F16）", () => {
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("retry");
    expect(boards.get("S").tasks[0].lastFailure?.exitCode).toBe(1);
  });
  it("失败用尽 → parked 且有 chainFinal 证据（F72/F74）", () => {
    jobs.put(job({ status: "failed", exitCode: 1, attempt: 4 }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
  it("killed 不写 lastFailure（F50/F73）", () => {
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "external", at: 250 } }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
  });
  it("kill running 不重试并 parked(killed)（F17）", () => {
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "external", at: 250 } }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("parked");
    expect(jobs.get("A")?.retryAt).toBeUndefined();
    expect(boards.get("S").tasks[0].park?.reason).toBe("killed");
  });
  it("恢复态 known:false → parked，不 completed（F5）", () => {
    jobs.put(job({ status: "failed", exitCode: null, exitCodeKnown: false }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
});

describe("人工优先（R2-5）", () => {
  it("任务已 parked 时只记证据，不覆盖 reason（F49）", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "我要的理由", at: 250, from: "in_progress" };
    boards.commit("S", b);
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "self", at: 260 } }));
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].park?.reason).toBe("我要的理由");
  });
  it("非 owner 会话不写别人的 board（F84）", () => {
    jobs.put(job({ sessionId: "OTHER" }));
    expect(autofillJob("A", { ...deps, sessionId: "S" }).action).toBe("recorded");
    expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
  });
  it("任务已 completed 时失败作业不降级为 parked（BLOCKER）", () => {
    const b = boards.get("S"); b.tasks[0].status = "completed"; boards.commit("S", b);
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("recorded");
    expect(boards.get("S").tasks[0].status).toBe("completed");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
    expect(jobs.get("A")?.retryAt).toBeUndefined();
  });
  it("任务已 parked 时失败作业不重试、不覆盖 reason（BLOCKER）", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "人工", at: 250, from: "in_progress" };
    boards.commit("S", b);
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("recorded");
    expect(boards.get("S").tasks[0].park?.reason).toBe("人工");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
    expect(jobs.get("A")?.retryAt).toBeUndefined();
  });
  it("任务已 parked 时 stale 作业不触发重验（BLOCKER）", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "人工", at: 250, from: "in_progress" };
    boards.commit("S", b);
    let calls = 0;
    deps.respawn = () => { calls++; return { ok: true }; };
    jobs.put(job({ fpEnd: "Y" }));
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(calls).toBe(0);
    expect(boards.get("S").tasks[0].park?.reason).toBe("人工");
  });
});
