import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { autofillJob } from "../../src/bind/autofill.js";
import { finalizeAndProject } from "../../src/bind/finalize.js";
import { applyMutation } from "../../src/board/reducer.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { createMonitor } from "../../src/jobs/monitor.js";
import { spawnJob } from "../../src/jobs/spawn.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { tryDeliver } from "../../src/wake/deliver.js";
import type { RuleContext } from "../../src/board/invariants.js";

it("一个 todo 挂 3 个真实作业：并行、日志独立、合并一条、completed 一次（V2）", async () => {
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
  s = applyMutation(s, { action: "create", tasks: [{ subject: "训练" }, { subject: "next" }] }, ctx()).state;
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

  // 真并行：最晚启动早于最早结束
  expect(Math.max(...spawned.map((j) => j.startedAt))).toBeLessThan(Math.min(...exited.map((j) => j.endedAt!)));
  // 日志各自独立
  expect(readFileSync(exited[0].logPath, "utf8").trim()).toBe("A");
  expect(readFileSync(exited[1].logPath, "utf8").trim()).toBe("B");
  expect(readFileSync(exited[2].logPath, "utf8").trim()).toBe("C");

  const deps = { boards, jobs, cfg: DEFAULTS, now: Date.now(), sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
  const actions = exited.map((j) => autofillJob(j.id, deps).action);
  expect(actions[0]).toBe("completed");
  expect(actions.slice(1)).toEqual(["recorded", "recorded"]);   // 已 completed，不再改状态
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
