import type { JobStore } from "./store.js";

export interface SaveCoalescer {
  /** 标记 sidecar 有变更；批次内延到批次结束，批次外立即落盘。 */
  save(): void;
  begin(): void;
  end(): void;
  /** 同步落盘（若有变更），用于换 store 与关闭前。 */
  flush(): void;
  pending(): boolean;
}

/**
 * 同一同步批次内的多次 save 合并为一次写；批次外保持原有的同步落盘语义。
 * 不引入定时器 / 微任务：状态变更仍在当前调用栈让出前完成。
 */
export function createSaveCoalescer(write: () => void): SaveCoalescer {
  let dirty = false;
  let depth = 0;
  const run = (): void => {
    if (!dirty) return;
    dirty = false;
    try {
      write();
    } catch (e) {
      dirty = true;
      throw e;
    }
  };
  return {
    save() {
      dirty = true;
      if (depth === 0) run();
    },
    begin() { depth++; },
    end() {
      if (depth > 0) depth--;
      if (depth === 0) run();
    },
    flush() { run(); },
    pending: () => dirty,
  };
}

/** 让所有调用方（finalize/sweep/ack）的 jobs.save() 走同一合并器。 */
export function withCoalescedSave(store: JobStore, c: SaveCoalescer): JobStore {
  return { ...store, save: c.save };
}