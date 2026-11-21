import type { JobStore } from "./store.js";

export const reservedSlots = (store: JobStore): number =>
  store.all().filter((j) => j.retryAt != null).length;

const runningCount = (store: JobStore): number =>
  store.all().filter((j) => j.status === "running").length;

export const admitNewSpawn = (store: JobStore, max: number): boolean =>
  runningCount(store) + reservedSlots(store) < max;

/** respawn 先摘下自己的 retryAt，再判 running < max（规格 §7.2 自锁修复）。 */
export const admitRespawn = (store: JobStore, rootId: string, max: number): boolean => {
  const running = store.all().filter((j) => j.status === "running" && j.rootId !== rootId).length;
  return running < max;
};
