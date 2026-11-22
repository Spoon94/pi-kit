import type { Job } from "../jobs/types.js";
import type { JobStore } from "../jobs/store.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";

export interface ArgCandidate {
  value: string;
  label: string;
  description?: string;
}

export const PANEL_SUBCOMMANDS: readonly ArgCandidate[] = [
  { value: "halt", label: "halt", description: "立即停止全部后台工作并 park 受影响任务（一键刹车，也可 alt+h）" },
  { value: "resume", label: "resume", description: "恢复自主推进（达轮数上限时会提示发消息归零）" },
  { value: "doctor", label: "doctor", description: "自检：冲突/孤儿/超期/环/WIP 超卖/轮数上限" },
  { value: "clear", label: "clear", description: "清理历史任务：默认 completed+deleted；pending/in_progress/parked 永不清" },
];

export const CLEAR_SCOPES: readonly ArgCandidate[] = [
  { value: "clear completed", label: "completed", description: "只清已完成任务" },
  { value: "clear deleted", label: "deleted", description: "只清已删除（tombstone）任务" },
  { value: "clear settled", label: "settled", description: "清 completed + deleted（默认范围）" },
];

export const BG_SUBCOMMANDS: readonly ArgCandidate[] = [
  { value: "k", label: "k", description: "中止整条作业链（两步确认）" },
  { value: "tail", label: "tail", description: "查看作业日志尾" },
];

export const COMPLETION_JOB_LIMIT = 50;

/** 纯函数、同步、只读：/vigil-todo 与 /vt 共用（T1/F131）。 */
export function panelCompletions(prefix: string): ArgCandidate[] | null {
  const text = typeof prefix === "string" ? prefix : "";
  const lower = text.toLowerCase();
  if (lower.startsWith("clear ")) {
    const q = lower.slice(6).trim();
    const scopes = CLEAR_SCOPES.filter((c) => c.label.startsWith(q));
    return scopes.length ? scopes : null;
  }
  const q = text.trim().toLowerCase();
  const items = PANEL_SUBCOMMANDS.filter((c) => c.value.startsWith(q));
  return items.length ? items : null;
}

const jobDescription = (j: Job): string => {
  const status = j.status === "running" ? "running" : j.retryAt != null ? "backoff" : j.status;
  const exit = j.exitCodeKnown && j.exitCode != null ? ` · exit ${j.exitCode}` : "";
  return sanitizeTerminalText(`${j.label} · ${status}${exit}`);
};

function jobCandidates(list: readonly Job[], head: "k" | "tail", typed: string): ArgCandidate[] | null {
  const q = typed.trim().toLowerCase();
  const out: ArgCandidate[] = [];
  for (const j of list) {
    const id = sanitizeTerminalText(j.id).trim();
    if (!id || /\s/.test(id)) continue;                 // 拒绝会拆出额外参数的畸形 id
    if (q && !id.toLowerCase().startsWith(q)) continue;
    out.push({ value: `${head} ${id}`, label: id, description: jobDescription(j) });
    if (out.length >= COMPLETION_JOB_LIMIT) break;
  }
  return out.length ? out : null;
}

/** /bg 的动态补全（T2）：只读 jobs 内存态，无 I/O、无定时器、无状态变更。 */
export function bgCompletions(prefix: string, jobs?: JobStore): ArgCandidate[] | null {
  try {
    const text = typeof prefix === "string" ? prefix : "";
    const lower = text.toLowerCase();
    if (lower.startsWith("k ")) {
      if (!jobs) return null;
      return jobCandidates(
        jobs.all().filter((j) => j.status === "running" || j.retryAt != null), "k", text.slice(2));
    }
    if (lower.startsWith("tail ")) {
      if (!jobs) return null;
      return jobCandidates(jobs.all(), "tail", text.slice(5));
    }
    const q = text.trim().toLowerCase();
    const items = BG_SUBCOMMANDS.filter((c) => c.value.startsWith(q));
    return items.length ? items : null;
  } catch {
    return null;                                        // 补全永不抛异常
  }
}

/** /todos 无参数候选（T3）。 */
export function todosCompletions(_prefix?: string): null {
  return null;
}