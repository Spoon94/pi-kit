import { appendEvidence } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import { chainTerminated } from "../jobs/chain.js";
import type { JobStore } from "../jobs/store.js";

/** 第一步：链级终结，权威在 sidecar，任何会话都可做，幂等。 */
export function finalizeChain(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean {
  if (!chainTerminated(jobs, rootId)) return false;
  const root = jobs.get(rootId);
  if (!root || root.finalized) return false;
  jobs.put({
    ...root,
    finalized: true,
    finalResult: { ok, note, trigger: root.kill?.requestedBy ?? "external", at: now },
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
  const task = { ...board.tasks[idx] };
  appendEvidence(task, {
    ok: root.finalResult.ok, kind: "job", origin: "async", chainFinal: true,
    trigger: root.finalResult.trigger, at: now, known: true,
    fp: root.fpVerdict, ref: rootId, note: root.finalResult.note,
    exitCode: root.exitCode,
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
