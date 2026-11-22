import type { JobStore } from "./store.js";

export const reservedSlots = (store: JobStore): number =>
  store.all().filter((j) => j.retryAt != null && !j.purged && !store.get(j.rootId)?.purged).length;

const runningCount = (store: JobStore): number =>
  store.all().filter((j) => j.status === "running").length;

export const admitNewSpawn = (store: JobStore, max: number): boolean =>
  runningCount(store) + reservedSlots(store) < max;

/** respawn first drops its own retryAt, then checks running < max (spec §7.2 self-lock fix). */
export const admitRespawn = (store: JobStore, rootId: string, max: number): boolean => {
  const running = store.all().filter((j) => j.status === "running" && j.rootId !== rootId).length;
  return running < max;
};
