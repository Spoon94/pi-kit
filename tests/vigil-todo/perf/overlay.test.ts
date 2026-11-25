import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { panelStamp, samePanelStamp } from "../../../src/vigil-todo/ui/panel.js";

it("F164 the no-change overlay gate costs well under 0.05ms (200 tasks / 10 jobs)", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-gate-")));
  for (let i = 0; i < 10; i++) {
    jobs.put({
      id: `j${i}`, rootId: `j${i}`, label: "l", command: "x", logPath: "/tmp/x", cwd: "/tmp", pid: 1,
      status: "running", exitCode: null, exitCodeKnown: false, startedAt: 0, endedAt: null,
      fpVerdict: "unknown", interferers: [], attempt: 1, taskId: i + 1, sessionId: "S",
      evidenceApplied: false, notifyState: "pending",
    } as never);
  }
  const b = emptyBoard();
  b.tasks = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, subject: `t${i}`, status: "pending" })) as Task[];
  b.nextId = 201;
  const prev = panelStamp(b, jobs, 60_000, false);
  const run = (): boolean => samePanelStamp(prev, panelStamp(b, jobs, 60_000, false));
  run(); run();                                                  // warm-up
  const times = Array.from({ length: 200 }, () => {
    const t0 = performance.now();
    run();
    return performance.now() - t0;
  }).sort((x, y) => x - y);
  const median = times[Math.floor(times.length / 2)];
  console.log(`overlay gate 200/10: median ${median.toFixed(4)} ms (max ${times.at(-1)!.toFixed(4)})`);
  expect(median).toBeLessThan(0.05);
});
