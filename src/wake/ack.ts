import type { BoardCounters } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import { WAKE_CUSTOM_TYPE } from "./compose.js";

/** Write root records only (spec §5.3 type constraint). */
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

/** After boundary delivery, wait for the immediately following agent_start; if entries are
 *  dropped, it never comes ⇒ leave sent for catch-up to cover. */
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
    /** Settle without continuation: boundary entries were dropped; clear the wait so the next unrelated agent_start does not ack by mistake. */
    onSettled(): void {
      pendingBoundary = undefined;
    },
    onMessage(jobs: JobStore, customType: string, wakeId: unknown): number {
      if (customType !== WAKE_CUSTOM_TYPE || typeof wakeId !== "string") return 0;
      return ackByWakeId(jobs, wakeId);
    },
  };
}
