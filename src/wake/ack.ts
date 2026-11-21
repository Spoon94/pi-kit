import type { BoardCounters } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import { WAKE_CUSTOM_TYPE } from "./compose.js";

/** 只写 root 记录（规格 §5.3 类型约束）。 */
export function markSent(jobs: JobStore, roots: string[], wakeId: string, now: number): void {
  for (const id of roots) {
    const j = jobs.get(id);
    if (!j || j.id !== j.rootId) continue;
    jobs.put({ ...j, notifyState: "sent", wakeId, notifySentAt: now });
  }
  jobs.save();
}

export function ackByWakeId(jobs: JobStore, wakeId: string): number {
  let n = 0;
  for (const j of jobs.all()) {
    if (j.id !== j.rootId || j.wakeId !== wakeId || j.notifyState === "acked") continue;
    jobs.put({ ...j, notifyState: "acked" });
    n++;
  }
  if (n) jobs.save();
  return n;
}

export function ackPendingBoundary(jobs: JobStore, sessionId: string): number {
  let n = 0;
  for (const j of jobs.all()) {
    if (j.id !== j.rootId || j.sessionId !== sessionId) continue;
    if (j.notifyState !== "sent") continue;
    jobs.put({ ...j, notifyState: "acked" });
    n++;
  }
  if (n) jobs.save();
  return n;
}

export const resetOnUserInput = (c: BoardCounters): BoardCounters => ({ ...c, turnsUsed: 0 });
export const clearRenudgeOnSettled = (c: BoardCounters): BoardCounters => ({ ...c, renudgeBudget: 0 });

/** boundary 投递后等待紧随的 agent_start；entries 被丢弃则永远等不到 ⇒ 留 sent 由 catch-up 兜。 */
export function createAckTracker() {
  let pendingBoundary: { wakeId: string; roots: string[] } | undefined;
  return {
    expectBoundary(wakeId: string, roots: string[]) { pendingBoundary = { wakeId, roots }; },
    onAgentStart(jobs: JobStore, _sessionId: string): number {
      if (!pendingBoundary) return 0;
      const { wakeId } = pendingBoundary;
      pendingBoundary = undefined;
      return ackByWakeId(jobs, wakeId);
    },
    onMessage(jobs: JobStore, customType: string, wakeId: unknown): number {
      if (customType !== WAKE_CUSTOM_TYPE || typeof wakeId !== "string") return 0;
      return ackByWakeId(jobs, wakeId);
    },
  };
}
