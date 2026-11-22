import type { JobStore } from "./store.js";

export interface SaveCoalescer {
  /** Mark the sidecar dirty; inside a batch postpone until batch end, outside a batch save immediately. */
  save(): void;
  begin(): void;
  end(): void;
  /** Synchronously save (if dirty); used when swapping stores and before shutdown. */
  flush(): void;
  pending(): boolean;
}

/**
 * Coalesce multiple saves in one synchronous batch into a single write; outside a batch keep
 * the original synchronous-save semantics. No timers / microtasks: state changes still complete
 * before the current call stack yields.
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

/** Route jobs.save() from all callers (finalize/sweep/ack) through the same coalescer. */
export function withCoalescedSave(store: JobStore, c: SaveCoalescer): JobStore {
  return { ...store, save: c.save };
}