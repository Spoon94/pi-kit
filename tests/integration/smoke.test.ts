import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { autofillJob } from "../../src/bind/autofill.js";
import { finalizeAndProject } from "../../src/bind/finalize.js";
import { sweepAll } from "../../src/bind/sweep.js";
import { applyMutation } from "../../src/board/reducer.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { createMonitor } from "../../src/jobs/monitor.js";
import { spawnJob } from "../../src/jobs/spawn.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { tryDeliver } from "../../src/wake/deliver.js";
import type { RuleContext } from "../../src/board/invariants.js";

it("真实作业 → 回填 → 终结 → 投影 → 投递（F4/F6/F72 闭环）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "{{SECRET_c5r8w0nt}}"));
  const boards = createBoardStore(); const jobs = createJobStore(dir);
  const ctx = (): RuleContext => ({
    wipLimit: 3, now: Date.now(),
    facts: {
      hasRunning: (id) => jobs.all().some((j) => j.taskId === id && j.status === "running"),
      hasBackoff: (id) => jobs.all().some((j) => j.taskId === id && j.retryAt != null),
      startedAt: (ref) => jobs.get(ref)?.startedAt, exists: (id) => jobs.get(id) !== undefined,
    },
  });
  let s = emptyBoard();
  s = applyMutation(s, { action: "create", tasks: [{ subject: "跑测试" }, { subject: "写文档" }] }, ctx()).state;
  s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
  boards.commit("S", s);

  const r = spawnJob({ command: "printf 'ok\\n'", cwd: dir, taskId: 1, sessionId: "S" }, dir, Date.now());
  if (!r.ok) throw new Error(r.error);
  jobs.put(r.job); jobs.save();
  const mon = createMonitor();
  const exited = await new Promise<typeof r.job>((res) => mon.watch(r.job, res, r.child));
  jobs.put(exited); jobs.save();
  mon.clearAll();

  const deps = { boards, jobs, cfg: DEFAULTS, now: Date.now(), sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
  // 非 git 目录 ⇒ fp unknown ⇒ 仍自动完成（F35）
  expect(autofillJob(exited.id, deps).action).toBe("completed");
  finalizeAndProject(exited.rootId, jobs, boards, "S", Date.now(), "done", true);
  sweepAll(deps);

  const d = tryDeliver({ board: boards.get("S"), jobs, cfg: DEFAULTS, now: Date.now(),
    trigger: "async", modelAdvanced: true, capacityFull: false });
  expect(d.kind).toBe("deliver");
  if (d.kind !== "deliver") return;
  expect(d.text).toContain("next: #2");
  expect(boards.get("S").tasks[0].status).toBe("completed");
});
