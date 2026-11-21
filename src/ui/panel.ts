import { completedSummary } from "../board/selectors.js";
import type { BoardState } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";

export const WIDGET_KEY = "vigil-todo";

export function layoutRows(state: BoardState, jobs: JobStore, budget: number) {
  const sum = completedSummary(state);
  const parked = state.tasks.filter((t) => t.status === "parked");
  const head = `● vigil-todo ${sum.done}/${sum.total}${parked.length ? ` · ⚠ ${parked.length} parked` : ""}`;
  const rows: string[] = [head];
  let used = 1;
  const summaryParts = [`${sum.done} done`, sum.allExit0 ? "all exit 0" : "有非零退出"];
  if (sum.fpUnknown) summaryParts.push(`⚠ ${sum.fpUnknown} 条 fp:?`);
  if (sum.reverified) summaryParts.push(`↺ ${sum.reverified} reverified`);
  if (sum.verifyChanged) summaryParts.push(`${sum.verifyChanged} verify changed`);
  if (sum.done > 0 && used < budget) { rows.push(`├─ ✓ ${summaryParts.join(" · ")}`); used++; }

  let hiddenParked = 0;
  for (const t of parked) {
    if (used + 2 > budget) { hiddenParked++; continue; }
    rows.push(`├─ ⚠ #${t.id} ${sanitizeTerminalText(t.subject)}  parked`);
    rows.push(`│    └─ ${sanitizeTerminalText(t.park?.reason ?? "")}`);
    used += 2;
  }
  for (const t of state.tasks.filter((x) => x.status === "in_progress")) {
    if (used >= budget) break;
    const running = jobs.all().find((j) => j.taskId === t.id && j.status === "running");
    const retry = running ? ` · ↻ retry ${running.attempt}/4` : "";
    rows.push(`├─ ◐ #${t.id} ${sanitizeTerminalText(t.subject)}${t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : ""}${retry}`);
    used++;
  }
  for (const t of state.tasks.filter((x) => x.defer)) {
    if (used >= budget) break;
    rows.push(`├─ ⏸ #${t.id} ${sanitizeTerminalText(t.subject)}  deferred → ${t.defer!.untilRoot}`);
    used++;
  }
  for (const t of state.tasks.filter((x) => x.status === "pending" && !x.defer)) {
    if (used >= budget) break;
    const dep = t.blockedBy?.length ? `  ⛓ ${t.blockedBy.map((d) => `#${d}`).join(",")}` : "";
    rows.push(`├─ ○ #${t.id} ${sanitizeTerminalText(t.subject)}${dep}`);
    used++;
  }
  if (hiddenParked) rows.push(`└─ +${hiddenParked} more parked`);
  else if (rows.length > 1) rows[rows.length - 1] = rows[rows.length - 1].replace("├─", "└─");
  return { rows, hiddenParked };
}

export function renderPanel(state: BoardState, jobs: JobStore, cfg: VigilConfig): string[] {
  if (state.tasks.every((t) => t.status === "deleted")) return [];
  return [...layoutRows(state, jobs, cfg.maxWidgetLines).rows, ""];
}

export function renderTodos(state: BoardState, _jobs: JobStore): string {
  return state.tasks.filter((t) => t.status !== "deleted").map((t) => {
    const fin = (t.evidence ?? []).filter((e) => e.chainFinal).at(-1);
    const ev = fin ? `  exit ${fin.exitCode ?? "?"} fp:${fin.fp}` : "";
    const park = t.park ? `  parked: ${t.park.reason}` : "";
    const defer = t.defer ? `  deferred → ${t.defer.untilRoot}` : "";
    return `[${t.status}] #${t.id} ${t.subject}${ev}${park}${defer}`;
  }).join("\n") || "No tasks";
}

export interface DoctorExtra { purgedRoots: number; retentionOverdue: number; orphanJobs: number }

export function renderDoctor(state: BoardState, jobs: JobStore, conflict: boolean, degraded?: string, extra?: DoctorExtra): string {
  const lines: string[] = [];
  if (conflict) lines.push("✗ todo 工具冲突：旧包未卸载，本扩展未注册事件处理器");
  if (degraded) lines.push(`✗ ${degraded}`);
  if (state.counters.halted) lines.push("⏸ 强制中断中 → /vigil-todo resume 恢复");
  if (extra?.purgedRoots) lines.push(`✗ ${extra.purgedRoots} 条链已 purge（adopt/catch-up 跳过）`);
  if (extra?.retentionOverdue) lines.push(`⚠ ${extra.retentionOverdue} 个 completed/deleted 任务超期未清理`);
  if (extra?.orphanJobs) lines.push(`⚠ ${extra.orphanJobs} 个孤儿作业（sidecar 无绑定任务）`);
  const orphanDefer = state.tasks.filter((t) => t.defer && !jobs.get(t.defer.untilRoot));
  if (orphanDefer.length) lines.push(`⚠ ${orphanDefer.length} 个 defer 目标已无记录`);
  const noEvidence = state.tasks.filter((t) => t.status === "in_progress" && (t.jobs?.length ?? 0) === 0);
  if (noEvidence.length) lines.push(`⚠ ${noEvidence.length} 个 in_progress 任务无绑定作业`);
  return lines.join("\n") || "✓ 未发现问题";
}
