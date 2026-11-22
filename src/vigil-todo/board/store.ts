import { emptyBoard, type BoardState } from "./types.js";

export function createBoardStore() {
  const slots = new Map<string, BoardState>();
  let front = "";
  const clone = (s: BoardState): BoardState => ({ tasks: s.tasks.map((t) => ({ ...t })), nextId: s.nextId, counters: { ...s.counters } });
  return {
    get: (sid: string): BoardState => slots.get(sid) ?? emptyBoard(),
    commit: (sid: string, s: BoardState) => { slots.set(sid, clone(s)); },
    replace: (sid: string, s: BoardState) => { slots.set(sid, clone(s)); },
    evict: (sid: string) => { slots.delete(sid); if (front === sid) front = ""; },
    setForeground: (sid: string) => { front = sid; },
    foreground: () => front,
    renderState: (): BoardState => slots.get(front) ?? emptyBoard(),
  };
}
export type BoardStore = ReturnType<typeof createBoardStore>;
