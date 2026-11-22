import type { JobFacts } from "../board/invariants.js";
import type { JobStore } from "./store.js";

/** JobFacts 的唯一实现：board 只通过该接口看作业事实。 */
export const jobFactsOf = (jobs: JobStore): JobFacts => ({
  hasRunning: (taskId) => jobs.all().some((j) => j.taskId === taskId && j.status === "running"),
  hasBackoff: (taskId) => jobs.all().some((j) => j.taskId === taskId && j.retryAt != null),
  startedAt: (ref) => jobs.get(ref)?.startedAt,
  exists: (id) => jobs.get(id) !== undefined,
});
