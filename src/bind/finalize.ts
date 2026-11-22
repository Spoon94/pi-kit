import { appendEvidence } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import { chainTerminated, isReverifyBranch, terminalJob } from "../jobs/chain.js";
import type { JobStore } from "../jobs/store.js";

/** 第一步：链级终结，权威在 sidecar，任何会话都可做，幂等。 */
function finalizeChainCore(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean {
  if (!chainTerminated(jobs, rootId)) return false;
  const root = jobs.get(rootId);
  if (!root || root.finalized) return false;
  const terminal = terminalJob(jobs, rootId) ?? root;
  const finalNote = ok && isReverifyBranch(terminal, jobs) ? `reverified · ${note}` : note;
  jobs.put({
    ...root,
    finalized: true,
    finalResult: { ok, note: finalNote, trigger: root.kill?.requestedBy ?? "external", at: now, jobId: terminal.id },
  });
  return true;
}

export function finalizeChain(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean {
  const changed = finalizeChainCore(rootId, jobs, now, note, ok);
  if (changed) jobs.save();
  return changed;
}

/** 第二步：只有 owner 会话能写自己的 board（铁律）。 */
function projectFinalCore(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number): boolean {
  const root = jobs.get(rootId);
  if (!root?.finalized || root.evidenceApplied || !root.finalResult) return false;
  if (root.sessionId !== sessionId) return false;
  const board = boards.get(sessionId);
  const idx = board.tasks.findIndex((t) => t.id === root.taskId);
  if (idx < 0) return false;
  const terminal = root.finalResult.jobId ? jobs.get(root.finalResult.jobId) ?? root : root;
  const task = { ...board.tasks[idx] };
  appendEvidence(task, {
    ok: root.finalResult.ok, kind: "job", origin: "async", chainFinal: true,
    trigger: root.finalResult.trigger, at: now, known: true,
    fp: terminal.fpVerdict, ref: rootId, note: root.finalResult.note,
    exitCode: terminal.exitCode,
  });
  const tasks = [...board.tasks]; tasks[idx] = task;
  boards.commit(sessionId, { ...board, tasks });
  jobs.put({ ...root, evidenceApplied: true });
  return true;
}

export function projectFinal(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number): boolean {
  const changed = projectFinalCore(rootId, jobs, boards, sessionId, now);
  if (changed) jobs.save();
  return changed;
}

/** 同一 tick 内两步都做：合并为一次落盘（P1）。 */
export function finalizeAndProject(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number, note: string, ok: boolean) {
  const finalized = finalizeChainCore(rootId, jobs, now, note, ok);
  const projected = projectFinalCore(rootId, jobs, boards, sessionId, now);
  if (finalized || projected) jobs.save();
  return { finalized, projected };
}