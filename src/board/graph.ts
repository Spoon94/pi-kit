import type { BoardState } from "./types.js";

/**
 * R21：依赖环检测。把 extra 提议边并入现有 blockedBy 图后做 DFS（三色标记），
 * 遇到灰色回边即返回环上的 id（首尾重复），无环返回 undefined。
 * 复杂度 O(V+E)；不做逐对比较。
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

  const color = new Map<number, 0 | 1 | 2>();   // 0 白 / 1 灰 / 2 黑
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

/** 环的可读形式：#1 ⛓ #2 ⛓ #1 */
export const formatCycle = (cycle: number[]): string => cycle.map((id) => `#${id}`).join(" ⛓ ");
