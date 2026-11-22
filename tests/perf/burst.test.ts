import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import vigilTodo from "../../extensions/vigil-todo.js";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore, runDir } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const counter = vi.hoisted(() => ({ writes: 0 }));
vi.mock("../../src/lib/atomic.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/atomic.js")>();
  return {
    ...mod,
    writeJsonAtomic: (path: string, value: unknown) => {
      counter.writes++;
      return mod.writeJsonAtomic(path, value);
    },
  };
});

const job = (id: string, i: number): Job => ({
  id, label: id, command: "true", logPath: "/tmp/x.log", cwd: process.cwd(), pid: 999_999,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpStart: "abc", fpVerdict: "unknown", interferers: [], rootId: id, attempt: 1,
  taskId: i + 1, sessionId: "S", evidenceApplied: false, notifyState: "pending",
});

beforeEach(() => {
  counter.writes = 0;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vigil-burst-cfg-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
});
afterEach(() => vi.useRealTimers());

it("10 jobs settle in one synchronous batch: one sidecar write, one board write per task (B2)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-burst-"));
  const store = createJobStore(runDir(cwd));
  const jobs = Array.from({ length: 10 }, (_, i) => job(`R${i}`, i));
  for (const j of jobs) store.put(j);
  store.save();

  const b = emptyBoard();
  b.tasks = jobs.map((j) => ({
    id: j.taskId!, subject: j.id, status: "in_progress" as const, inProgressSince: 0, jobs: [j.id],
  }));
  b.nextId = 11;
  const branch: any[] = [{ type: "custom", customType: "rpiv-todo-state",
    data: { action: "snapshot", params: {}, tasks: b.tasks, nextId: b.nextId, counters: b.counters } }];
  const handlers: Record<string, ((e: any, c: any) => unknown)[]> = {};
  const ctx = {
    cwd, hasUI: false, mode: "text",
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    isIdle: () => true,
    executeTool: async () => ({ isError: false, result: { structuredContent: { exit_code: 0 } } }),
    sessionManager: { getSessionId: () => "S", getCwd: () => cwd, getBranch: () => branch, getSessionDir: () => cwd },
  };
  const api: any = {
    on: (n: string, f: any) => { (handlers[n] ??= []).push(f); return () => {}; },
    registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
    getAllTools: () => [{ name: "todo", sourceInfo: { source: "pi-kit" } }],
    getSettings: () => ({}),
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: () => Promise.resolve(),
  };
  vigilTodo(api);

  const before = counter.writes;
  const beforeSnaps = branch.filter((e) => e.customType === "rpiv-todo-state").length;
  const t0 = performance.now();
  for (const fn of handlers.session_start ?? []) await fn({ type: "session_start", reason: "startup" }, ctx);
  const duration = performance.now() - t0;

  const snapshots = branch.filter((e) => e.customType === "rpiv-todo-state").length - beforeSnaps;
  console.log(`burst: ${duration.toFixed(1)}ms, sidecar writes=${counter.writes - before}, snapshots=${snapshots}`);
  expect(counter.writes - before).toBe(1);
  expect(snapshots).toBe(2);                   // 1 task-state snapshot + 1 delivery-count snapshot; the 10 tasks do not each write one
  const loaded = createJobStore(runDir(cwd));
  loaded.load();
  expect(loaded.all().filter((j) => j.status === "failed").length).toBe(10);
  for (const j of loaded.all()) expect(j.fpEnd).toBeTypeOf("string");
});