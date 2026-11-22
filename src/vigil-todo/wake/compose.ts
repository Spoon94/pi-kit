import type { BoardState, Task } from "../board/types.js";
import type { Job } from "../jobs/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { formatElapsed } from "../lib/format.js";
import { fpReason } from "../lib/fingerprint.js";
import { sanitizeMultiline, sanitizeTerminalText } from "../lib/sanitize.js";
import { tailLines } from "../lib/tail.js";

export const WAKE_CUSTOM_TYPE = "vigil-todo-wake";

const WAKE_MAX = 4800;
const MARKER_RESERVE = 80;
const TAIL_MIN_BUDGET = 200;

const cost = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0);

function footerLines(board: BoardState, cfg: VigilConfig, next: Task | undefined): string[] {
  const active = board.tasks.filter((t) => t.status === "in_progress").length;
  if (next) {
    return [
      `next: #${next.id} ${sanitizeTerminalText(next.subject)} (pending, unblocked)`,
      `→ Start: bg_run({task_id:${next.id}, command:"…"})`,
      `  Needs a decision: todo({action:"update", id:${next.id}, status:"parked", reason:"…"})`,
    ];
  }
  if (active >= cfg.wipLimit) return [`WIP full (${active}/${cfg.wipLimit}); park one first or wait for one to finish`];
  return ["No actionable tasks"];
}

/** Build the wake message incrementally: status lines and failure reasons first, log tails from the
 *  remaining budget. Once the budget is spent, later logs are not read at all. */
export function composeWake(roots: string[], board: BoardState, jobs: JobStore, cfg: VigilConfig, next: Task | undefined): string {
  const footer = footerLines(board, cfg, next);
  let budget = WAKE_MAX - cost(footer) - MARKER_RESERVE;
  const valid = roots.map((id) => jobs.get(id)).filter((r): r is Job => r !== undefined);
  const blocks: { root: Job; core: string[]; tail: string[] }[] = [];
  let used = 0;
  let notExpanded = 0;

  for (let i = 0; i < valid.length; i++) {
    const root = valid[i];
    const j = root.finalResult?.jobId ? jobs.get(root.finalResult.jobId) ?? root : root;
    const task = board.tasks.find((t) => t.id === j.taskId);
    const label = sanitizeTerminalText(j.label);
    const tag = root.finalResult?.ok ? "✓" : "✗";
    const elapsed = formatElapsed((j.endedAt ?? Date.now()) - j.startedAt);
    const core = [`[vigil-todo] #${j.taskId ?? "?"} ${label} ${tag} exit ${j.exitCode ?? "?"} · ${elapsed} (${root.id}) ${fpReason(j)}`];
    if (root.finalResult && !root.finalResult.ok) core.push(`  ${sanitizeTerminalText(root.finalResult.note)}`);
    if (j.fpVerdict === "stale" && task?.status === "parked") {
      core.push(`  → todo({action:"update", id:${j.taskId}, status:"completed", accept:"stale"})`);
      core.push(`    todo({action:"verify", id:${j.taskId}})`);
    }
    const c = cost(core);
    if (used + c > budget) { notExpanded += valid.length - i; break; }
    used += c;
    blocks.push({ root, core, tail: [] });
  }

  for (const b of blocks) {
    if (b.root.finalResult?.ok) continue;
    const j = b.root.finalResult?.jobId ? jobs.get(b.root.finalResult.jobId) ?? b.root : b.root;
    if (!jobs.isSafeLogPath(j.logPath)) continue;
    const remaining = budget - used;
    if (remaining < TAIL_MIN_BUDGET) { notExpanded++; continue; }
    const tail = tailLines(j.logPath, cfg.tailLines, cfg.maxTailBytes);
    if (!tail.length) continue;
    const header = `  log tail (last ${tail.length}):`;
    b.tail.push(header);
    used += header.length + 1;
    let appended = 0;
    for (const l of tail) {
      const line = `    ${sanitizeTerminalText(l).slice(0, 200)}`;
      if (used + line.length + 1 > budget) break;
      b.tail.push(line);
      used += line.length + 1;
      appended++;
    }
    if (appended < tail.length) notExpanded++;
  }

  const out: string[] = [];
  for (const b of blocks) out.push(...b.core, ...b.tail);
  if (notExpanded > 0) out.push(`... ${notExpanded} chains not fully expanded`);
  out.push(...footer);
  return sanitizeMultiline(out.join("\n")).slice(0, WAKE_MAX);
}
