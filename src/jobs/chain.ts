import type { JobStore } from "./store.js";
import type { Job } from "./types.js";

export const chainJobs = (store: JobStore, rootId: string): Job[] =>
  store.all().filter((j) => j.rootId === rootId);

/** 链的末次 job：按写入顺序（store 迭代顺序）取最后一条，不依赖毫秒时间戳。 */
export const terminalJob = (store: JobStore, rootId: string): Job | undefined => {
  const list = chainJobs(store, rootId);
  return list[list.length - 1] ?? store.get(rootId);
};

/** 沿 retryOf 上溯，任一祖先（含自身）带 staleReverifyOf 即属重验分支。 */
export function isReverifyBranch(job: Job, store: JobStore): boolean {
  let cur: Job | undefined = job;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.staleReverifyOf) return true;
    cur = cur.retryOf ? store.get(cur.retryOf) : undefined;
  }
  return false;
}

export const nextAttempt = (job: Job): number => job.attempt + 1;
export const retryDelayMs = (attempt: number, delays: number[]): number =>
  delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 0;

/** attempt 上限 = 1 + retries；含重验分支内的失败重试。 */
export const canRetry = (job: Job, _store: JobStore, retries: number): boolean =>
  job.attempt < 1 + retries;

/** 重验额度落链上；重验分支后代永不再触发。为「重验 + 至少一次失败重试」预留 job 槽。 */
export function canReverify(job: Job, store: JobStore, staleReverify: number, retries = 0): boolean {
  if (staleReverify <= 0) return false;
  if (isReverifyBranch(job, store)) return false;
  const list = chainJobs(store, job.rootId);
  const used = list.filter((j) => j.staleReverifyOf != null).length;
  if (used >= staleReverify) return false;
  // 界证明：重验 job 继承被重验 job 的 attempt（autofill/sweep 的 respawn），
  // 失败重试只补到 attempt=1+retries ⇒ 总 job 数 ≤ list + (1+retries-attempt)
  // ≤ 1+retries+staleReverify。预留槽保证重验后至少还有一次重试。
  const maxJobs = 1 + retries + staleReverify;
  const guaranteedRetry = retries > 0 ? 1 : 0;   // 重验失败至少还能再重试一次
  return list.length + 1 + guaranteedRetry <= maxJobs;
}

/** 派生终结判定（规格 §4.5）：无 running、无 retryAt、无待重验。 */
export function chainTerminated(store: JobStore, rootId: string): boolean {
  const list = chainJobs(store, rootId);
  if (list.length === 0) return true;                       // 孤儿 root
  const root = store.get(rootId);
  if (root?.pendingReverify) return false;
  return list.every((j) => j.status !== "running" && j.retryAt == null);
}
