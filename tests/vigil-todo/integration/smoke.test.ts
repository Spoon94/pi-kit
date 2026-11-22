import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { autofillJob } from "../../../src/vigil-todo/bind/autofill.js";
import { finalizeAndProject } from "../../../src/vigil-todo/bind/finalize.js";
import { sweepAll } from "../../../src/vigil-todo/bind/sweep.js";
import { applyMutation } from "../../../src/vigil-todo/board/reducer.js";
import { createBoardStore } from "../../../src/vigil-todo/board/store.js";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createMonitor } from "../../../src/vigil-todo/jobs/monitor.js";
import { spawnJob } from "../../../src/vigil-todo/jobs/spawn.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import { tryDeliver } from "../../../src/vigil-todo/wake/deliver.js";
import type { RuleContext } from "../../../src/vigil-todo/board/invariants.js";

it("Real job → autofill → finalize → project → deliver (F4/F6/F72 closed loop)", async () => {
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
  s = applyMutation(s, { action: "create", tasks: [{ subject: "run tests" }, { subject: "write docs" }] }, ctx()).state;
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
  // Non-git directory ⇒ fp unknown ⇒ still auto-completes (F35)
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
