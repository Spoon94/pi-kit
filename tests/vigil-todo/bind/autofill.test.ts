import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autofillJob, type AutofillDeps } from "../../../src/vigil-todo/bind/autofill.js";
import { createBoardStore } from "../../../src/vigil-todo/board/store.js";
import { emptyBoard, type Task } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";

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

describe("success path", () => {
  it("fresh + valid evidence → automatically completed (F4)", () => {
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("completed");
    expect(boards.get("S").tasks[0].status).toBe("completed");
  });
  it("unknown also completes automatically (F58)", () => {
    jobs.put(job({ fpEnd: "Y", interferers: ["B"] }));
    jobs.put(job({ id: "B", taskId: 2, rootId: "B", startedAt: 150, endedAt: 250, fpStart: "X", fpEnd: "Z" }));
    expect(autofillJob("A", deps).action).toBe("completed");
  });
  it("repeated calls write only one evidence record (F31)", () => {
    jobs.put(job());
    autofillJob("A", deps); autofillJob("A", deps);
    expect(boards.get("S").tasks[0].evidence).toHaveLength(1);
  });
});

describe("stale auto-reverify", () => {
  it("first stale triggers reverify without parking or completing (F64)", () => {
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("reverify");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
    expect(jobs.get("A")?.pendingReverify).toBe(true);
  });
  it("reverify runs task.verify.command when present (F68)", () => {
    const b = boards.get("S"); b.tasks[0].verify = { kind: "command", command: "npm run check" }; boards.commit("S", b);
    let cmd = "";
    deps.respawn = (req) => { cmd = req.command; return { ok: true }; };
    jobs.put(job({ fpEnd: "Y" }));
    autofillJob("A", deps);
    expect(cmd).toBe("npm run check");
  });
  it("reverify quota exhausted → parked (F20)", () => {
    jobs.put(job({ fpEnd: "Y" }));
    jobs.put(job({ id: "R1", rootId: "A", retryOf: "A", staleReverifyOf: "A", fpEnd: "Z" }));
    expect(autofillJob("A", { ...deps, now: 400 }).action).toBe("parked");
  });
  it("reverify rejected by capacity → parked (F69)", () => {
    deps.respawn = () => ({ ok: false, error: "capacity" });
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("parked");
    expect(r.reason).toContain("slot");
  });
  it("a task with verifyChanged cannot auto-complete (F53)", () => {
    const b = boards.get("S"); b.tasks[0].verifyChanged = true; boards.commit("S", b);
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
  });
});

describe("failure and termination", () => {
  it("failure before exhaustion → retry and write lastFailure (F16)", () => {
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("retry");
    expect(boards.get("S").tasks[0].lastFailure?.exitCode).toBe(1);
  });
  it("5th failure still retries (6 total attempts)", () => {
    jobs.put(job({ status: "failed", exitCode: 1, attempt: 5 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("retry");
    expect(jobs.get("A")?.retryAt).toBeGreaterThan(300);
  });
  it("only the 6th failure parks (exhausted)", () => {
    jobs.put(job({ status: "failed", exitCode: 1, attempt: 6 }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
  it("killed does not write lastFailure (F50/F73)", () => {
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "external", at: 250 } }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
  });
  it("killing a running job does not retry and parks(killed) (F17)", () => {
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "external", at: 250 } }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("parked");
    expect(jobs.get("A")?.retryAt).toBeUndefined();
    expect(boards.get("S").tasks[0].park?.reason).toBe("killed");
  });
  it("recovered known:false → parked, never completed (F5)", () => {
    jobs.put(job({ status: "failed", exitCode: null, exitCodeKnown: false }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
});

describe("human-first (R2-5)", () => {
  it("when the task is already parked, record evidence only and keep its reason (F49)", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "my reason", at: 250, from: "in_progress" };
    boards.commit("S", b);
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "self", at: 260 } }));
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].park?.reason).toBe("my reason");
  });
  it("a non-owner session does not write another board (F84)", () => {
    jobs.put(job({ sessionId: "OTHER" }));
    expect(autofillJob("A", { ...deps, sessionId: "S" }).action).toBe("recorded");
    expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
  });
  it("an out-of-bounds logPath is not read into lastFailure (MINOR #2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "{{SECRET_dzs7b2he}}"));
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "TOPSECRET");
    jobs.put(job({ status: "failed", exitCode: 1, attempt: 6, logPath: secret }));
    autofillJob("A", deps);
    expect(boards.get("S").tasks[0].lastFailure?.note).toBeUndefined();
    expect(boards.get("S").tasks[0].park?.reason ?? "").not.toContain("TOPSECRET");
  });
  it("a failed job does not downgrade an already-completed task to parked (BLOCKER)", () => {
    const b = boards.get("S"); b.tasks[0].status = "completed"; boards.commit("S", b);
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("recorded");
    expect(boards.get("S").tasks[0].status).toBe("completed");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
    expect(jobs.get("A")?.retryAt).toBeUndefined();
  });
  it("a failed job does not retry or overwrite the reason of an already-parked task (BLOCKER)", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "manual", at: 250, from: "in_progress" };
    boards.commit("S", b);
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("recorded");
    expect(boards.get("S").tasks[0].park?.reason).toBe("manual");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
    expect(jobs.get("A")?.retryAt).toBeUndefined();
  });
  it("a stale job does not trigger reverify when the task is already parked (BLOCKER)", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "manual", at: 250, from: "in_progress" };
    boards.commit("S", b);
    let calls = 0;
    deps.respawn = () => { calls++; return { ok: true }; };
    jobs.put(job({ fpEnd: "Y" }));
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(calls).toBe(0);
    expect(boards.get("S").tasks[0].park?.reason).toBe("manual");
  });
});

describe("reverify branch boundedness (§5.2.1 / BLOCKER)", () => {
  const chain = (n: number, lastStale: boolean) => {
    const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`);
    ids.forEach((id, i) => jobs.put(job({
      id, rootId: "R", retryOf: i ? ids[i - 1] : undefined, attempt: i + 1,
      status: i === n - 1 && lastStale ? "completed" : "failed",
      exitCode: i === n - 1 && lastStale ? 0 : 1,
      endedAt: 10 + i, fpStart: "X", fpEnd: i === n - 1 && lastStale ? "Y" : "Z",
      fpVerdict: i === n - 1 && lastStale ? "stale" : "unknown",
      taskId: 1, sessionId: "S",
    })));
    return ids;
  };

  it("a6 stale no longer triggers reverify without quota (BLOCKER)", () => {
    chain(6, true);
    let calls = 0;
    deps.respawn = () => { calls++; return { ok: true }; };
    const r = autofillJob("a6", deps);
    expect(r.action).toBe("parked");
    expect(calls).toBe(0);
  });

  it("a5 stale triggers reverify; a failed reverify can still retry (BLOCKER)", () => {
    const ids = chain(5, true);
    let calls = 0;
    deps.respawn = () => { calls++; return { ok: true }; };
    expect(autofillJob("a5", deps).action).toBe("reverify");
    expect(calls).toBe(1);
    jobs.put(job({
      id: "RV", rootId: "R", retryOf: "a5", staleReverifyOf: "a5", attempt: 5,
      status: "failed", exitCode: 1, endedAt: 20, taskId: 1, sessionId: "S",
    }));
    expect(ids).toHaveLength(5);
    expect(autofillJob("RV", deps).action).toBe("retry");
    expect(jobs.get("RV")?.retryAt).toBeDefined();
  });
});
