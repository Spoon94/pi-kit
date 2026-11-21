import type { BoardState, Task } from "./types.js";

const settled = (s: Task["status"]) => s === "completed" || s === "deleted";

export const wipCount = (state: BoardState): number =>
  state.tasks.filter((t) => t.status === "in_progress").length;

export function selectNext(state: BoardState, wipLimit: number, capacityFull: boolean): Task | undefined {
  if (capacityFull || wipCount(state) >= wipLimit) return undefined;
  return state.tasks
    .filter((t) => t.status === "pending" && !t.park && !t.defer
      && (t.blockedBy ?? []).every((id) => { const d = state.tasks.find((x) => x.id === id); return d !== undefined && settled(d.status); }))
    .sort((a, b) => a.id - b.id)[0];
}

export function completedSummary(state: BoardState) {
  const visible = state.tasks.filter((t) => t.status !== "deleted");
  const done = visible.filter((t) => t.status === "completed");
  const finals = done.flatMap((t) => (t.evidence ?? []).filter((e) => e.chainFinal));
  return {
    done: done.length,
    total: visible.length,
    allExit0: finals.every((e) => e.ok && e.exitCode === 0),
    fpUnknown: finals.filter((e) => e.fp === "unknown").length,
    reverified: finals.filter((e) => e.note?.includes("reverified")).length,
    verifyChanged: done.filter((t) => t.verifyChanged).length,
  };
}
