import type { BoardState, Task } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { formatElapsed } from "../lib/format.js";
import { fpReason } from "../lib/fingerprint.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";
import { tailLines } from "../lib/tail.js";

export const WAKE_CUSTOM_TYPE = "vigil-todo-wake";

export function composeWake(roots: string[], board: BoardState, jobs: JobStore, cfg: VigilConfig, next: Task | undefined): string {
  const lines: string[] = [];
  for (const id of roots) {
    const root = jobs.get(id);
    if (!root) continue;
    const j = root.finalResult?.jobId ? jobs.get(root.finalResult.jobId) ?? root : root;
    const task = board.tasks.find((t) => t.id === j.taskId);
    const label = sanitizeTerminalText(j.label);
    const tag = root.finalResult?.ok ? "✓" : "✗";
    const elapsed = formatElapsed((j.endedAt ?? Date.now()) - j.startedAt);
    lines.push(`[vigil-todo] #${j.taskId ?? "?"} ${label} ${tag} exit ${j.exitCode ?? "?"} · ${elapsed} (${root.id}) ${fpReason(j)}`);
    if (root.finalResult && !root.finalResult.ok) lines.push(`  ${sanitizeTerminalText(root.finalResult.note)}`);
    if (j.fpVerdict === "stale" && task?.status === "parked") {
      lines.push(`  → todo({action:"update", id:${j.taskId}, status:"completed", accept:"stale"})`);
      lines.push(`    todo({action:"verify", id:${j.taskId}})`);
    }
    if (!root.finalResult?.ok) {
      const tail = tailLines(j.logPath, cfg.tailLines, cfg.maxTailBytes);
      if (tail.length) { lines.push(`  log tail (last ${tail.length}):`); for (const l of tail) lines.push(`    ${sanitizeTerminalText(l).slice(0, 200)}`); }
    }
  }
  const active = board.tasks.filter((t) => t.status === "in_progress").length;
  if (next) {
    lines.push(`next: #${next.id} ${sanitizeTerminalText(next.subject)} (pending, unblocked)`);
    lines.push(`→ 开干: bg_run({task_id:${next.id}, command:"…"})`);
    lines.push(`  需人拍板: todo({action:"update", id:${next.id}, status:"parked", reason:"…"})`);
  } else if (active >= cfg.wipLimit) {
    lines.push(`WIP 满 (${active}/${cfg.wipLimit})，先 park 一个或等一个完成`);
  } else {
    lines.push("无可推进任务");
  }
  return lines.join("\n").slice(0, 4800);
}
