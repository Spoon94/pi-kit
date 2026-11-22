import { appendEvidence, completionGate, recordFailure } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import type { Evidence, Task } from "../board/types.js";
import { canRetry, canReverify, retryDelayMs } from "../jobs/chain.js";
import { jobFactsOf } from "../jobs/facts.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { classifyOverlap, verdictAt } from "../lib/fingerprint.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";
import { tailLines } from "../lib/tail.js";

export interface AutofillDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string;
  respawn(req: SpawnRequest): { ok: boolean; error?: string };
  notify(note: string): void;
}
export type AutofillAction = "completed" | "parked" | "retry" | "reverify" | "recorded";

export function autofillJob(jobId: string, d: AutofillDeps): { action: AutofillAction; reason?: string } {
  const job = d.jobs.get(jobId);
  if (!job) return { action: "recorded" };
  const board = d.boards.get(d.sessionId);
  const idx = board.tasks.findIndex((t) => t.id === job.taskId);
  const task: Task | undefined = idx >= 0 ? { ...board.tasks[idx] } : undefined;

  // 非 owner / 无绑定任务：只落 job 侧，不碰 board（铁律）
  if (!task || job.sessionId !== d.sessionId) return { action: "recorded" };

  // F31：同一 job 重复回调只写一条证据
  if ((task.evidence ?? []).some((e) => e.kind === "job" && e.origin === "async" && e.ref === job.id)) {
    return { action: "recorded" };
  }

  const fp = verdictAt(job, d.jobs);
  const cls = classifyOverlap(job, d.jobs);
  d.jobs.put({ ...job, fpVerdict: fp, interferers: cls.interferers });

  const ok = job.exitCodeKnown && job.exitCode === 0 && job.status === "completed";
  const tailLine = ok || !d.jobs.isSafeLogPath(job.logPath)
    ? undefined
    : sanitizeTerminalText(tailLines(job.logPath, 1, d.cfg.maxTailBytes)[0] ?? "") || undefined;
  const ev: Evidence = {
    ok, kind: "job", origin: "async", chainFinal: false, at: d.now,
    exitCode: job.exitCode, known: job.exitCodeKnown, fp, ref: job.id,
    note: tailLine,
  };

  const humanFirst = task.status !== "in_progress";
  const commit = (mut: (t: Task) => void, action: AutofillAction, reason?: string) => {
    const next = { ...task };
    appendEvidence(next, ev);
    mut(next);
    const tasks = [...board.tasks]; tasks[idx] = next;
    d.boards.commit(d.sessionId, { ...board, tasks });
    return { action, reason };
  };
  const park = (next: Task, reason: string) => {
    next.status = "parked"; next.statusSince = d.now;
    next.park = { reason, at: d.now, from: task.status };
  };

  // 人工优先：回填时任务已不在 in_progress ⇒ 只记证据，绝不改状态/重试/park
  if (humanFirst) return commit(() => {}, "recorded");

  if (job.status === "failed" && job.exitCodeKnown && job.exitCode !== 0) {
    recordFailure(task, { exitCode: job.exitCode, ref: job.id, at: d.now, note: ev.note });
    if (canRetry(job, d.jobs, d.cfg.retries)) {
      const delay = retryDelayMs(job.attempt, d.cfg.retryDelaysMs);
      d.jobs.put({ ...d.jobs.get(job.id)!, retryAt: d.now + delay });
      return commit(() => {}, "retry");
    }
    const reason = `${job.attempt} 次均失败${ev.note ? ` · ${ev.note}` : ""}`;
    return commit((t) => park(t, reason), "parked", reason);
  }

  if (job.status === "killed" || !job.exitCodeKnown) {
    const reason = job.status === "killed" ? "killed" : "退出码未知，需重验";
    return commit((t) => park(t, reason), "parked", reason);
  }

  // ok === true
  if (fp === "stale") {
    if (canReverify(job, d.jobs, d.cfg.staleReverify, d.cfg.retries)) {
      const command = task.verify?.command ?? job.command;
      const r = d.respawn({
        command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
        rootId: job.rootId, retryOf: job.id, attempt: job.attempt, staleReverifyOf: job.id,
        label: `reverify ${job.label}`,
      });
      if (r.ok) {
        const root = d.jobs.get(job.rootId);
        if (root) d.jobs.put({ ...root, pendingReverify: true });
        return commit(() => {}, "reverify");
      }
      const reason = "无空闲槽位重验";
      return commit((t) => park(t, reason), "parked", reason);
    }
    const reason = "工作区持续变动，证据无法确认";
    return commit((t) => park(t, reason), "parked", reason);
  }

  if (task.verifyChanged) return commit(() => {}, "recorded");
  const withEv: Task = { ...task };
  appendEvidence(withEv, ev);
  if (completionGate(withEv, jobFactsOf(d.jobs))) return commit(() => {}, "recorded");
  return commit((t) => { t.status = "completed"; t.statusSince = d.now; }, "completed");
}
