import { appendEvidence } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import { chainTerminated, isReverifyBranch, terminalJob } from "../jobs/chain.js";
import type { JobStore } from "../jobs/store.js";

/** 第一步：链级终结，权威在 sidecar，任何会话都可做，幂等。 */
export function finalizeChain(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean {
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
  jobs.save();
  return true;
}

/** 第二步：只有 owner 会话能写自己的 board（铁律）。 */
export function projectFinal(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number): boolean {
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
  jobs.save();
  return true;
}

export function finalizeAndProject(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number, note: string, ok: boolean) {
  return {
    finalized: finalizeChain(rootId, jobs, now, note, ok),
    projected: projectFinal(rootId, jobs, boards, sessionId, now),
  };
}
