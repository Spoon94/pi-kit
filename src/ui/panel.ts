import { completedSummary, selectNext, wipCount } from "../board/selectors.js";
import type { BoardState } from "../board/types.js";
import { detectCycle, formatCycle } from "../board/graph.js";
import type { JobStore } from "../jobs/store.js";
import { DEFAULTS, type VigilConfig } from "../lib/config.js";
import { formatElapsed } from "../lib/format.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";

export const WIDGET_KEY = "vigil-todo";

export function layoutRows(
  state: BoardState, jobs: JobStore, budget: number,
  cfg: VigilConfig = DEFAULTS, now = Date.now(),
) {
  const sum = completedSummary(state);
  const parked = state.tasks.filter((t) => t.status === "parked");
  const atLimit = state.counters.turnsUsed >= cfg.maxTurns;
  const pending = state.tasks.filter((t) => t.status === "pending");
  const busySlots = jobs.all().filter((j) => j.status === "running" || j.retryAt != null).length;
  const capacityFull = busySlots >= cfg.maxConcurrentJobs;
  const stuck = pending.length > 0 && !capacityFull && wipCount(state) < cfg.wipLimit
    && selectNext(state, cfg.wipLimit, capacityFull) === undefined;
  const head = `● vigil-todo ${sum.done}/${sum.total}${parked.length ? ` · ⚠ ${parked.length} parked` : ""}`
    + `${atLimit ? ` · ⏸ 达轮数上限 (${state.counters.turnsUsed}/${cfg.maxTurns})` : ""}`
    + `${stuck ? " · ⚠ 无可推进" : ""}`;
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
    const elapsed = running ? ` · ✶ ${formatElapsed(now - running.startedAt)}` : "";
    const retry = running ? ` · ↻ retry ${running.attempt}/${1 + cfg.retries}` : "";
    rows.push(`├─ ◐ #${t.id} ${sanitizeTerminalText(t.subject)}${t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : ""}${elapsed}${retry}`);
    used++;
  }
  for (const t of state.tasks.filter((x) => x.status === "pending")) {
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
  return [...layoutRows(state, jobs, cfg.maxWidgetLines, cfg).rows, ""];
}

export function renderTodos(state: BoardState, _jobs: JobStore): string {
  return state.tasks.filter((t) => t.status !== "deleted").map((t) => {
    const fin = (t.evidence ?? []).filter((e) => e.chainFinal).at(-1);
    const ev = fin ? `  exit ${fin.exitCode ?? "?"} fp:${fin.fp}` : "";
    const park = t.park ? `  parked: ${t.park.reason}` : "";
    return `[${t.status}] #${t.id} ${t.subject}${ev}${park}`;
  }).join("\n") || "No tasks";
}

export interface DoctorExtra {
  purgedRoots: number; retentionOverdue: number; orphanJobs: number;
  maxTurns?: number; wipLimit?: number; maxConcurrentJobs?: number;
}

export function renderDoctor(state: BoardState, jobs: JobStore, conflict: boolean, degraded?: string, extra?: DoctorExtra): string {
  const lines: string[] = [];
  if (conflict) lines.push("✗ todo 工具冲突：旧包未卸载，本扩展未注册事件处理器");
  if (degraded) lines.push(`✗ ${degraded}`);
  if (state.counters.halted) lines.push("⏸ 强制中断中 → /vigil-todo resume 恢复");
  const maxTurns = extra?.maxTurns ?? DEFAULTS.maxTurns;
  if (state.counters.turnsUsed >= maxTurns) {
    lines.push(`⏸ 达轮数上限 (${state.counters.turnsUsed}/${maxTurns}) → 用户发消息归零`);
  }
  const wipLimit = extra?.wipLimit ?? DEFAULTS.wipLimit;
  const maxJobs = extra?.maxConcurrentJobs ?? DEFAULTS.maxConcurrentJobs;
  const pending = state.tasks.filter((t) => t.status === "pending");
  const busySlots = jobs.all().filter((j) => j.status === "running" || j.retryAt != null).length;
  const capacityFull = busySlots >= maxJobs;
  const stuck = pending.length > 0 && !capacityFull && wipCount(state) < wipLimit
    && selectNext(state, wipLimit, capacityFull) === undefined;
  if (stuck) {
    lines.push(`⚠ 有 ${pending.length} 个 pending 但无可推进任务（依赖环或全部被阻塞）→ /todos 查依赖`);
  }
  const cycle = detectCycle(state);
  if (cycle) {
    lines.push(`✗ 检测到依赖环：${formatCycle(cycle)} → todo({action:"update", id:${cycle[0]}, removeBlockedBy:[…]})`);
  }
  if (extra?.purgedRoots) lines.push(`✗ ${extra.purgedRoots} 条链已 purge（catch-up 跳过）`);
  if (extra?.retentionOverdue) lines.push(`⚠ ${extra.retentionOverdue} 个 completed/deleted 任务超期未清理`);
  if (extra?.orphanJobs) lines.push(`⚠ ${extra.orphanJobs} 个孤儿作业（sidecar 无绑定任务）`);
  const noEvidence = state.tasks.filter((t) => t.status === "in_progress" && (t.jobs?.length ?? 0) === 0);
  if (noEvidence.length) lines.push(`⚠ ${noEvidence.length} 个 in_progress 任务无绑定作业`);
  return lines.join("\n") || "✓ 未发现问题";
}
