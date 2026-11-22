import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { autofillJob } from "../../../src/vigil-todo/bind/autofill.js";
import { finalizeAndProject } from "../../../src/vigil-todo/bind/finalize.js";
import { applyMutation } from "../../../src/vigil-todo/board/reducer.js";
import { createBoardStore } from "../../../src/vigil-todo/board/store.js";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createMonitor } from "../../../src/vigil-todo/jobs/monitor.js";
import { spawnJob } from "../../../src/vigil-todo/jobs/spawn.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import { tryDeliver } from "../../../src/vigil-todo/wake/deliver.js";
import type { RuleContext } from "../../../src/vigil-todo/board/invariants.js";

it("One todo with 3 real jobs: parallel, independent logs, one merged delivery, completed once (V2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-multi-"));
  const boards = createBoardStore();
  const jobs = createJobStore(dir);
  const ctx = (): RuleContext => ({
    wipLimit: 1, now: Date.now(),
    facts: {
      hasRunning: (id) => jobs.all().some((j) => j.taskId === id && j.status === "running"),
      hasBackoff: (id) => jobs.all().some((j) => j.taskId === id && j.retryAt != null),
      startedAt: (ref) => jobs.get(ref)?.startedAt,
      exists: (id) => jobs.get(id) !== undefined,
    },
  });
  let s = emptyBoard();
  s = applyMutation(s, { action: "create", tasks: [{ subject: "training" }, { subject: "next" }] }, ctx()).state;
  s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
  boards.commit("S", s);

  const specs = [["A", "0.2"], ["B", "0.4"], ["C", "0.6"]] as const;
  const mon = createMonitor();
  const spawned: Job[] = [];
  const waits = specs.map(([label, secs]) => {
    const r = spawnJob({ command: `sleep ${secs}; echo ${label}`, cwd: dir, taskId: 1, sessionId: "S" }, dir, Date.now());
    if (!r.ok) throw new Error(r.error);
    jobs.put(r.job);
    jobs.save();
    spawned.push(r.job);
    return new Promise<Job>((res) => mon.watch(r.job, res, r.child));
  });
  const exited = await Promise.all(waits);
  mon.clearAll();
  for (const j of exited) { jobs.put(j); jobs.save(); }

  // Truly parallel: the latest start is earlier than the earliest end
  expect(Math.max(...spawned.map((j) => j.startedAt))).toBeLessThan(Math.min(...exited.map((j) => j.endedAt!)));
  // Logs are independent
  expect(readFileSync(exited[0].logPath, "utf8").trim()).toBe("A");
  expect(readFileSync(exited[1].logPath, "utf8").trim()).toBe("B");
  expect(readFileSync(exited[2].logPath, "utf8").trim()).toBe("C");

  const deps = { boards, jobs, cfg: DEFAULTS, now: Date.now(), sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
  const actions = exited.map((j) => autofillJob(j.id, deps).action);
  expect(actions[0]).toBe("completed");
  expect(actions.slice(1)).toEqual(["recorded", "recorded"]);   // Already completed; status no longer changes
  for (const j of exited) finalizeAndProject(j.rootId, jobs, boards, "S", Date.now(), "completed", true);

  const task = boards.get("S").tasks[0];
  expect(task.status).toBe("completed");
  expect(task.evidence?.filter((e) => e.chainFinal)).toHaveLength(3);

  const delivered = tryDeliver({ board: boards.get("S"), jobs, cfg: DEFAULTS, now: Date.now(),
    trigger: "async", modelAdvanced: true, capacityFull: false });
  expect(delivered.kind).toBe("deliver");
  if (delivered.kind === "deliver") {
    expect(delivered.roots).toHaveLength(3);
    expect(delivered.text).toContain("next: #2");
  }
  expect(boards.get("S").tasks[0].status).toBe("completed");
});
