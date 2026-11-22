import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSaveCoalescer, withCoalescedSave } from "../../src/jobs/coalesce.js";
import { createJobStore } from "../../src/jobs/store.js";

it("批次内多次 save 合并为一次同步写", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.begin(); c.save(); c.save(); c.save();
  expect(writes).toBe(0);
  c.end();
  expect(writes).toBe(1);
  c.end();                                  // 多余的 end 不写
  expect(writes).toBe(1);
});

it("批次外 save 保持同步落盘（durability 不变）", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.save();
  expect(writes).toBe(1);
  c.flush();                                // 无 dirty，不重复写
  expect(writes).toBe(1);
});

it("嵌套批次只在最外层结束时落盘", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; });
  c.begin(); c.begin(); c.save(); c.end();
  expect(writes).toBe(0);
  c.end();
  expect(writes).toBe(1);
});

it("写失败保留 dirty，下次 flush 重试", () => {
  let writes = 0;
  const c = createSaveCoalescer(() => { writes++; if (writes === 1) throw new Error("disk"); });
  expect(() => c.save()).toThrow("disk");
  expect(c.pending()).toBe(true);
  c.flush();
  expect(c.pending()).toBe(false);
  expect(writes).toBe(2);
});

it("withCoalescedSave 只替换 save，其他方法保持原行为", () => {
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