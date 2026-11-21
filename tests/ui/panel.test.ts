import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Evidence, type Task } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { layoutRows, renderDoctor, renderPanel, renderTodos } from "../../src/ui/panel.js";

const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp: "fresh", exitCode: 0, ref: "R", ...o,
});
const done = (id: number, fp: "fresh" | "unknown" = "fresh"): Task =>
  ({ id, subject: `d${id}`, status: "completed", evidence: [ev({ fp, ref: `R${id}` })] });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const jobs = () => createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_z8p3x1cq}}")));

it("首行含 done/total 与 parked 数（F25）", () => {
  const s = b([done(1), { id: 2, subject: "p", status: "parked", park: { reason: "需拍板", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows[0]).toContain("1/2");
  expect(rows[0]).toContain("1 parked");
});

it("completed 汇总一行带证据与 fp:? 计数（F58）", () => {
  const s = b([done(1), done(2, "unknown"), done(3, "unknown")]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  const summary = rows.find((r) => r.includes("done ·"));
  expect(summary).toContain("3 done");
  expect(summary).toContain("all exit 0");
  expect(summary).toContain("2 条 fp:?");
});

it("parked reason 独占缩进行（F25）", () => {
  const s = b([{ id: 1, subject: "p", status: "parked", park: { reason: "公开 API 需拍板", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows.some((r) => r.includes("└─ 公开 API 需拍板"))).toBe(true);
});

it("超预算优先保 parked，截断给出 +N more parked（F25）", () => {
  const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, subject: `p${i}`, status: "parked" as const, park: { reason: `r${i}`, at: 1, from: "pending" as const },
  }));
  const r = layoutRows(b(tasks), jobs(), 6);
  expect(r.hiddenParked).toBeGreaterThan(0);
  expect(r.rows.join("\n")).toContain("more parked");
  expect(r.rows[0]).toContain("10 parked");
});

it("空列表返回空数组（自动卸载）", () => {
  expect(renderPanel(emptyBoard(), jobs(), DEFAULTS)).toEqual([]);
});

it("/todos 逐条带 exit code 与 fp（F58 下钻）", () => {
  const text = renderTodos(b([done(1), done(2, "unknown")]), jobs());
  expect(text).toContain("#1");
  expect(text).toContain("exit 0");
  expect(text).toContain("fp:unknown");
});

it("doctor 报冲突与降级（F13/F12）", () => {
  const text = renderDoctor(emptyBoard(), jobs(), true, "sidecar 损坏");
  expect(text).toContain("冲突");
  expect(text).toContain("sidecar 损坏");
});

it("doctor 报 halted / purged / 超期 / 孤儿作业", () => {
  const b = emptyBoard();
  b.counters.halted = true;
  b.tasks = [{ id: 1, subject: "old", status: "completed", statusSince: 1 }];
  const text = renderDoctor(b, jobs(), false, undefined, { purgedRoots: 2, retentionOverdue: 1, orphanJobs: 3 });
  expect(text).toContain("强制中断");
  expect(text).toContain("2");
  expect(text).toContain("超期");
  expect(text).toContain("孤儿作业");
});
