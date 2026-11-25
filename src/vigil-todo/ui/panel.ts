import { completedSummary, selectNext, wipCount } from "../board/selectors.js";
import type { BoardState } from "../board/types.js";
import { detectCycle, formatCycle } from "../board/graph.js";
import type { JobStore } from "../jobs/store.js";
import { DEFAULTS, type VigilConfig } from "../lib/config.js";
import { formatElapsedCoarse, quantizeNow } from "../lib/format.js";
import { sanitizeMultiline, sanitizeTerminalText } from "../lib/sanitize.js";

export const WIDGET_KEY = "vigil-todo";
export const STATUS_KEY = "vigil-todo-status";

/** Persistent status-line indicator (C2); empty when there are no tasks or jobs, taking no space. */
export function renderStatus(state: BoardState, jobs: JobStore): string | undefined {
  if (state.counters.halted) return "vigil ⏸ halted";
  const active = jobs.all().filter((j) => j.status === "running" || j.retryAt != null).length;
  if (active > 0) return `vigil ● ${active} job${active === 1 ? "" : "s"}`;
  const parked = state.tasks.filter((t) => t.status === "parked").length;
  if (parked > 0) return `vigil ⚠ ${parked} parked`;
  const visible = state.tasks.filter((t) => t.status !== "deleted");
  if (visible.length === 0) return undefined;
  const done = visible.filter((t) => t.status === "completed").length;
  return `vigil ✓ ${done}/${visible.length}`;
}

/** Truncate panel rows to display width (conservatively by char count) with an ellipsis; the full /todos view does not truncate. */
export function truncateToWidth(value: string, width: number): string {
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

export function layoutRows(
  state: BoardState, jobs: JobStore, budget: number,
  cfg: VigilConfig = DEFAULTS, now = Date.now(), width = 100,
) {
  const sum = completedSummary(state, jobs);
  const parked = state.tasks.filter((t) => t.status === "parked");
  const atLimit = state.counters.turnsUsed >= cfg.maxTurns;
  const pending = state.tasks.filter((t) => t.status === "pending");
  const busySlots = jobs.all().filter((j) => j.status === "running" || j.retryAt != null).length;
  const capacityFull = busySlots >= cfg.maxConcurrentJobs;
  const stuck = pending.length > 0 && !capacityFull && wipCount(state) < cfg.wipLimit
    && selectNext(state, cfg.wipLimit, capacityFull) === undefined;
  const active = wipCount(state);
  const oversold = active > cfg.wipLimit;
  const head = `● vigil-todo ${sum.done}/${sum.total}${parked.length ? ` · ⚠ ${parked.length} parked` : ""}`
    + `${atLimit ? ` · ⏸ turn limit reached (${state.counters.turnsUsed}/${cfg.maxTurns})` : ""}`
    + `${oversold ? ` · ⚠ WIP oversold (${active}/${cfg.wipLimit})` : ""}`
    + `${stuck ? " · ⚠ nothing actionable" : ""}`;
  const rows: string[] = [head];
  let used = 1;
  const summaryParts = [
    `${sum.done} done`,
    sum.evidenceRolled ? "⚠ evidence rolled" : (sum.allExit0 ? "all exit 0" : "nonzero exit"),
  ];
  if (sum.fpUnknown) summaryParts.push(`⚠ ${sum.fpUnknown} with fp:?`);
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
    const elapsed = running ? ` · ✶ ${formatElapsedCoarse(now - running.startedAt, cfg.elapsedGranularityMs)}` : "";
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
  return { rows: rows.map((r) => truncateToWidth(sanitizeTerminalText(r), width)), hiddenParked };
}

export function renderPanel(
  state: BoardState, jobs: JobStore, cfg: VigilConfig, width = 100, now = quantizeNow(Date.now(), cfg.elapsedGranularityMs),
): string[] {
  if (state.tasks.every((t) => t.status === "deleted")) return [];
  return [...layoutRows(state, jobs, cfg.maxWidgetLines, cfg, now, width).rows, ""];
}

/** Cheap identity of everything the live panel shows; equal stamps mean "no re-render needed". */
export interface PanelStamp {
  board: unknown; jobs: number; running: number; retry: number;
  now: number; halted: boolean | undefined; turns: number; collapsed: boolean;
}

export function panelStamp(
  board: BoardState, jobs: JobStore, now: number, collapsed: boolean,
): PanelStamp {
  let running = 0;
  let retry = 0;
  for (const j of jobs.all()) {
    if (j.status === "running") running++;
    if (j.retryAt != null) retry++;
  }
  return {
    board, jobs: jobs.all().length, running, retry,
    now, halted: board.counters.halted, turns: board.counters.turnsUsed, collapsed,
  };
}

export function samePanelStamp(a: PanelStamp | undefined, b: PanelStamp): boolean {
  return a !== undefined && a.board === b.board && a.jobs === b.jobs && a.running === b.running
    && a.retry === b.retry && a.now === b.now && a.halted === b.halted
    && a.turns === b.turns && a.collapsed === b.collapsed;
}

export function renderTodos(state: BoardState, _jobs: JobStore): string {
  const text = state.tasks.filter((t) => t.status !== "deleted").map((t) => {
    const fin = (t.evidence ?? []).filter((e) => e.chainFinal).at(-1);
    const ev = fin ? `  exit ${fin.exitCode ?? "?"} fp:${fin.fp}` : "";
    const park = t.park ? `  parked: ${t.park.reason}` : "";
    return `[${t.status}] #${t.id} ${t.subject}${ev}${park}`;
  }).join("\n") || "No tasks";
  return sanitizeMultiline(text);
}

export interface DoctorExtra {
  purgedRoots: number; retentionOverdue: number; orphanJobs: number;
  maxTurns?: number; wipLimit?: number; maxConcurrentJobs?: number;
}

export function renderDoctor(state: BoardState, jobs: JobStore, conflict: boolean, degraded?: string, extra?: DoctorExtra): string {
  const lines: string[] = [];
  if (conflict) lines.push("✗ todo tool conflict: old package not unloaded, this extension registered no event handlers");
  if (degraded) lines.push(`✗ ${degraded}`);
  if (state.counters.halted) lines.push("⏸ Halted → /vigil-todo resume to resume");
  const maxTurns = extra?.maxTurns ?? DEFAULTS.maxTurns;
  if (state.counters.turnsUsed >= maxTurns) {
    lines.push(`⏸ Turn limit reached (${state.counters.turnsUsed}/${maxTurns}) → user sends a message to reset`);
  }
  const wipLimit = extra?.wipLimit ?? DEFAULTS.wipLimit;
  const maxJobs = extra?.maxConcurrentJobs ?? DEFAULTS.maxConcurrentJobs;
  const active = wipCount(state);
  if (active > wipLimit) {
    lines.push(`⚠ ${active} in_progress exceeds wipLimit=${wipLimit} (historical residue; park to release)`);
  }
  const pending = state.tasks.filter((t) => t.status === "pending");
  const busySlots = jobs.all().filter((j) => j.status === "running" || j.retryAt != null).length;
  const capacityFull = busySlots >= maxJobs;
  const stuck = pending.length > 0 && !capacityFull && wipCount(state) < wipLimit
    && selectNext(state, wipLimit, capacityFull) === undefined;
  if (stuck) {
    lines.push(`⚠ ${pending.length} pending but nothing actionable (dependency cycle or all blocked) → /todos to inspect dependencies`);
  }
  const cycle = detectCycle(state);
  if (cycle) {
    lines.push(`✗ Dependency cycle detected: ${formatCycle(cycle)} → todo({action:"update", id:${cycle[0]}, removeBlockedBy:[…]})`);
  }
  if (extra?.purgedRoots) {
    lines.push(`✗ ${extra.purgedRoots} chains purged (catch-up skips them) → expected after clear, no action needed; create a new task to rerun`);
  }
  if (extra?.retentionOverdue) {
    lines.push(`⚠ ${extra.retentionOverdue} completed/deleted tasks overdue for cleanup → /vt clear to clear history (terminal only)`);
  }
  if (extra?.orphanJobs) {
    lines.push(`⚠ ${extra.orphanJobs} orphan jobs (no bound task in sidecar) → bg_list to inspect, bg_kill({job_id:"…"}) to reclaim`);
  }
  const noEvidence = state.tasks.filter((t) => t.status === "in_progress" && (t.jobs?.length ?? 0) === 0);
  if (noEvidence.length) {
    const id = noEvidence[0].id;
    lines.push(`⚠ ${noEvidence.length} in_progress tasks have no bound job (e.g. #${id}) → todo({action:"verify", id:${id}}) to re-collect evidence, or start a job`);
  }
  return lines.length ? sanitizeMultiline(lines.join("\n")) : "✓ No issues found";
}
