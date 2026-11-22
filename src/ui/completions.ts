import type { Job } from "../jobs/types.js";
import type { JobStore } from "../jobs/store.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";

export interface ArgCandidate {
  value: string;
  label: string;
  description?: string;
}

export const PANEL_SUBCOMMANDS: readonly ArgCandidate[] = [
  { value: "halt", label: "halt", description: "Immediately stop all background work and park affected tasks (one-key brake; alt+h also works)" },
  { value: "resume", label: "resume", description: "Resume autonomous progress (at the turn limit, prompts to send a message to reset)" },
  { value: "doctor", label: "doctor", description: "Self-check: conflicts/orphans/overdue/cycles/WIP oversold/turn limit" },
  { value: "clear", label: "clear", description: "Clear task history: completed+deleted by default; pending/in_progress/parked are never cleared" },
];

export const CLEAR_SCOPES: readonly ArgCandidate[] = [
  { value: "clear completed", label: "completed", description: "Clear only completed tasks" },
  { value: "clear deleted", label: "deleted", description: "Clear only deleted (tombstone) tasks" },
  { value: "clear settled", label: "settled", description: "Clear completed + deleted (default scope)" },
];

export const BG_SUBCOMMANDS: readonly ArgCandidate[] = [
  { value: "k", label: "k", description: "Abort the whole job chain (two-step confirmation)" },
  { value: "tail", label: "tail", description: "View the job log tail" },
];

export const COMPLETION_JOB_LIMIT = 50;

/** Pure, synchronous, read-only: shared by /vigil-todo and /vt (T1/F131). */
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
    if (!id || /\s/.test(id)) continue;                 // reject malformed ids that would split into extra arguments
    if (q && !id.toLowerCase().startsWith(q)) continue;
    out.push({ value: `${head} ${id}`, label: id, description: jobDescription(j) });
    if (out.length >= COMPLETION_JOB_LIMIT) break;
  }
  return out.length ? out : null;
}

/** Dynamic completion for /bg (T2): reads jobs in-memory only; no I/O, timers, or state changes. */
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
    return null;                                        // completion never throws
  }
}

/** /todos has no argument candidates (T3). */
export function todosCompletions(_prefix?: string): null {
  return null;
}