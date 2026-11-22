import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Evidence, type Task } from "../../src/board/types.js";
import type { Job } from "../../src/jobs/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { layoutRows, renderDoctor, renderPanel, renderStatus, renderTodos } from "../../src/ui/panel.js";

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

it("C2 状态栏：进度 / 运行作业 / parked / halted / 空态清空", () => {
  const empty = jobs();
  expect(renderStatus(emptyBoard(), empty)).toBeUndefined();

  const progress = b([done(1), { id: 2, subject: "p", status: "pending" }]);
  expect(renderStatus(progress, empty)).toBe("vigil ✓ 1/2");

  const parked = b([{ id: 1, subject: "p", status: "parked", park: { reason: "r", at: 1, from: "pending" } }]);
  expect(renderStatus(parked, empty)).toBe("vigil ⚠ 1 parked");

  const halted = { ...progress, counters: { ...progress.counters, halted: true } };
  expect(renderStatus(halted, empty)).toBe("vigil ⏸ halted");

  const running = jobs();
  running.put({
    id: "bg_x", label: "x", command: "true", logPath: "/tmp/x.log", cwd: "/tmp", pid: 1,
    status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
    fpVerdict: "unknown", interferers: [], rootId: "bg_x", attempt: 1,
    evidenceApplied: false, notifyState: "pending",
  });
  expect(renderStatus(progress, running)).toBe("vigil ● 1 job");
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

it("达轮数上限在面板首行与 doctor 标注（F24）", () => {
  const s = b([{ id: 1, subject: "p", status: "pending" }]);
  s.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(renderPanel(s, jobs(), DEFAULTS)[0]).toContain("达轮数上限");
  expect(renderDoctor(s, jobs(), false)).toContain("达轮数上限");
});

it("in_progress 行显示 ✶ 耗时，retry 上限随配置（§8.1）", () => {
  const now = 1_000_000;
  const s = b([{ id: 1, subject: "补单测", status: "in_progress", activeForm: "writing tests" }]);
  const jj = jobs();
  const running: Job = {
    id: "bg_x", label: "x", command: "true", logPath: "/tmp/x.log", cwd: "/tmp", pid: 1,
    status: "running", exitCode: null, exitCodeKnown: false, startedAt: now - 130_000, endedAt: null,
    fpVerdict: "unknown", interferers: [], rootId: "bg_x", attempt: 1, taskId: 1, sessionId: "S",
    evidenceApplied: false, notifyState: "pending",
  };
  jj.put(running);
  const { rows } = layoutRows(s, jj, 12, DEFAULTS, now);
  const line = rows.find((r) => r.includes("#1")) ?? "";
  expect(line).toContain("✶ 2m10s");
  expect(line).toContain("retry 1/6");                 // 默认总尝试 6
  const custom = layoutRows(s, jj, 12, { ...DEFAULTS, retries: 1 }, now);
  expect(custom.rows.find((r) => r.includes("#1")) ?? "").toContain("retry 1/2");
});

it("证据滚动时汇总不显示 all exit 0（MINOR #3）", () => {
  const evidence: Evidence[] = Array.from({ length: 8 }, (_, i) => ({
    ok: false, kind: "job", origin: "async", chainFinal: false,
    at: i, known: true, fp: "fresh", exitCode: 1, ref: `bg_${i}`,
  }));
  const s = b([{ id: 1, subject: "d", status: "completed", jobs: ["bg_a"], evidence }]);
  const summary = renderPanel(s, jobs(), DEFAULTS).find((r) => r.includes("done ·")) ?? "";
  expect(summary).toContain("证据已滚动");
  expect(summary).not.toContain("all exit 0");
});

it("WIP 超卖在面板与 doctor 可见（MINOR #5）", () => {
  const tasks: Task[] = [
    { id: 1, subject: "i1", status: "in_progress" },
    { id: 2, subject: "i2", status: "in_progress" },
    { id: 3, subject: "i3", status: "in_progress" },
    { id: 4, subject: "p", status: "pending" },
  ];
  const s = b(tasks);
  expect(renderPanel(s, jobs(), { ...DEFAULTS, wipLimit: 1 })[0]).toContain("WIP 超卖 (3/1)");
  const doc = renderDoctor(s, jobs(), false, undefined,
    { purgedRoots: 0, retentionOverdue: 0, orphanJobs: 0, wipLimit: 1 });
  expect(doc).toContain("超过 wipLimit=1");
  expect(doc).not.toContain("无可推进");
});

it("面板按宽度截断加省略号，/todos 全量不截断（F115）", () => {
  const long = "x".repeat(300);
  const s = b([
    { id: 1, subject: long, status: "pending" },
    { id: 2, subject: "p", status: "parked", park: { reason: long, at: 1, from: "pending" } },
  ]);
  const rows = renderPanel(s, jobs(), DEFAULTS).filter((r) => r !== "");
  for (const r of rows) expect(Array.from(r).length).toBeLessThanOrEqual(100);
  expect(rows.join("\n")).toContain("…");

  const narrow = layoutRows(s, jobs(), 12, DEFAULTS, 1, 60).rows;
  for (const r of narrow) expect(Array.from(r).length).toBeLessThanOrEqual(60);

  expect(renderTodos(s, jobs())).toContain(long);
});

it("汇总行覆盖非零退出 / reverified / verify changed 分支", () => {
  const s = b([
    { id: 1, subject: "a", status: "completed", verifyChanged: true, evidence: [ev({ ok: false, exitCode: 1 })] },
    { id: 2, subject: "b", status: "completed", evidence: [ev({ note: "reverified" })] },
  ]);
  const summary = renderPanel(s, jobs(), DEFAULTS).find((r) => r.includes("done ·")) ?? "";
  expect(summary).toContain("有非零退出");
  expect(summary).toContain("reverified");
  expect(summary).toContain("verify changed");
});

it("parked 缺 reason、预算截断与 renderTodos 空证据分支", () => {
  const parked = b([{ id: 1, subject: "p", status: "parked" }]);
  expect(renderPanel(parked, jobs(), DEFAULTS).some((r) => r.includes("└─"))).toBe(true);

  const many: Task[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: i + 1, subject: `i${i}`, status: "in_progress" as const })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: i + 5, subject: `p${i}`, status: "pending" as const })),
  ];
  const { rows } = layoutRows(b(many), jobs(), 3);
  expect(rows).toHaveLength(3);

  const doneNoFin = b([{ id: 1, subject: "a", status: "completed" }]);
  expect(renderTodos(doneNoFin, jobs())).toContain("[completed] #1 a");
  expect(renderTodos(emptyBoard(), jobs())).toBe("No tasks");
});
