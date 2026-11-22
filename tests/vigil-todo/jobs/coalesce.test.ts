import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSaveCoalescer, withCoalescedSave } from "../../../src/vigil-todo/jobs/coalesce.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";

it("multiple saves within a batch coalesce into one synchronous write", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.begin(); c.save(); c.save(); c.save();
  expect(writes).toBe(0);
  c.end();
  expect(writes).toBe(1);
  c.end();                                  // extra end does not write
  expect(writes).toBe(1);
});

it("save outside a batch still writes synchronously (durability unchanged)", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.save();
  expect(writes).toBe(1);
  c.flush();                                // no dirty state, no duplicate write
  expect(writes).toBe(1);
});

it("nested batches write only when the outermost batch ends", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.begin(); c.begin(); c.save(); c.end();
  expect(writes).toBe(0);
  c.end();
  expect(writes).toBe(1);
});

it("a failed write keeps dirty so the next flush retries", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; if (writes === 1) throw new Error("disk"); });
  expect(() => c.save()).toThrow("disk");
  expect(c.pending()).toBe(true);
  c.flush();
  expect(c.pending()).toBe(false);
  expect(writes).toBe(2);
});

it("withCoalescedSave replaces only save; other methods keep their behavior", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-coalesce-")));
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  const w = withCoalescedSave(s, c);
  w.put({ id: "R", label: "r", command: "true", logPath: "/tmp/r.log", cwd: "/tmp", pid: 1,
    status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
    fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
    evidenceApplied: false, notifyState: "pending" });
  w.save();
  expect(writes).toBe(1);
  c.flush();
  expect(writes).toBe(1);
  expect(w.get("R")?.id).toBe("R");
});