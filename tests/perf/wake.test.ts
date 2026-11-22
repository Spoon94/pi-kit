import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../../src/lib/tail.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/tail.js")>();
  return {
    ...mod,
    tailLines: (...args: Parameters<typeof mod.tailLines>) => {
      counter.reads++;
      return mod.tailLines(...args);
    },
  };
});

import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { composeWake } from "../../src/wake/compose.js";
import type { Job } from "../../src/jobs/types.js";

it("P1 50-chain wake stops reading logs once the output budget is spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-budget-"));
  mkdirSync(join(dir, "logs"));
  const jobs = createJobStore(dir);
  const roots: string[] = [];
  for (let i = 0; i < 50; i++) {
    const log = join(dir, "logs", `j${i}.log`);
    writeFileSync(log, Array.from({ length: 500 }, (_, k) => `line ${k} of job ${i} with some text`).join("\n"));
    const id = `bg_${i}`;
    const job: Job = {
      id, label: `job ${i}`, command: "npm test", logPath: log, cwd: "/tmp", pid: 1,
      status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1000, endedAt: 61_000,
      fpVerdict: "fresh", interferers: [], rootId: id, attempt: 6, taskId: i + 1, sessionId: "S",
      evidenceApplied: true, finalized: true, notifyState: "pending",
      finalResult: { ok: false, note: "failed after 6 attempts", trigger: "external", at: 61_000, jobId: id },
    };
    jobs.put(job);
    roots.push(id);
  }

  counter.reads = 0;
  const text = composeWake(roots, emptyBoard(), jobs, DEFAULTS, undefined);

  expect(text.length).toBeLessThanOrEqual(4800);
  expect(counter.reads).toBeLessThan(roots.length);
  expect(text).toContain("chains not fully expanded");
  expect(text).toContain("job 0");                    // the earliest status line survives
});
