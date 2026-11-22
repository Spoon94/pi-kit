import type { BoardState } from "./types.js";

/**
 * R21: dependency cycle detection. Merge extra proposed edges into the existing blockedBy graph,
 * then DFS (three-color marking); a gray back-edge returns the ids on the cycle (head == tail);
 * undefined when acyclic. Complexity O(V+E); no pairwise comparison.
 */
export function detectCycle(
  state: BoardState,
  extra?: { taskId: number; deps: number[] },
): number[] | undefined {
  const ids = new Set(state.tasks.map((t) => t.id));
  const adj = new Map<number, number[]>();
  for (const t of state.tasks) {
    const raw = extra && extra.taskId === t.id ? extra.deps : t.blockedBy ?? [];
    adj.set(t.id, [...new Set(raw.filter((d) => ids.has(d)))]);
  }

  const color = new Map<number, 0 | 1 | 2>();   // 0 white / 1 gray / 2 black
  const stack: number[] = [];

  const visit = (id: number): number[] | undefined => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === 0) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return undefined;
  };

  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Readable cycle form: #1 ⛓ #2 ⛓ #1 */
export const formatCycle = (cycle: number[]): string => cycle.map((id) => `#${id}`).join(" ⛓ ");
