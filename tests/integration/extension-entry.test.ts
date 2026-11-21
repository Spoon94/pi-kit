import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import vigilTodo from "../../extensions/vigil-todo.js";
import { emptyBoard, type BoardState } from "../../src/board/types.js";
import { createJobStore, runDir } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

type Handler = (event: any, ctx: any) => unknown;

const job = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "回归", command: "npm test", logPath: "/tmp/r.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1, taskId: 1, sessionId: "S",
  evidenceApplied: true, finalized: true, notifyState: "pending",
  finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: "R" }, ...o,
});

const snapshot = (state: BoardState) => ({
  type: "custom", customType: "rpiv-todo-state",
  data: { action: "snapshot", params: {}, tasks: state.tasks, nextId: state.nextId, counters: state.counters },
});

const completedWithEvidence = (refs: string[], extra?: (b: BoardState) => void): BoardState => {
  const b = emptyBoard();
  b.tasks = refs.map((ref, i) => ({
    id: i + 1, subject: `t${i + 1}`, status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref, exitCode: 0 }],
  }));
  b.nextId = refs.length + 1;
  extra?.(b);
  return b;
};

function makeHarness(cwd: string, branch: unknown[], idle = true) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const sent: any[] = [];
  let isIdle = idle;
  const ctx = {
    cwd, hasUI: false, mode: "text",
    ui: { notify: () => {}, setWidget: () => {} },
    isIdle: () => isIdle,
    sessionManager: {
      getSessionId: () => "S",
      getCwd: () => cwd,
      getBranch: () => branch,
      getSessionDir: () => join(cwd, ".sessions"),
    },
  };
  const api: any = {
    on: (name: string, fn: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {};
    },
    registerTool: () => {},
    registerCommand: (name: string, opts: any) => { commands.set(name, opts.handler); },
    registerShortcut: () => {},
    getAllTools: () => [{ name: "todo", sourceInfo: { source: "pi-kit" } }],
    getSettings: () => ({}),
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); return Promise.resolve(); },
  };
  const emit = async (name: string, event: any = { type: name }): Promise<any> => {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };
  const runCommand = async (name: string, args: string): Promise<void> => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`command ${name} not registered`);
    await handler(args, ctx);
  };
  const setIdle = (v: boolean) => { isIdle = v; };
  return { api, emit, runCommand, sent, setIdle, ctx };
}

const setupJobs = (cwd: string, jobs: Job[]) => {
  const store = createJobStore(runDir(cwd));
  for (const j of jobs) store.put(j);
  store.save();
};

const writeConfig = (wakeMergeMs = 0) => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({ wakeMergeMs }));
  return home;
};

let oldConfigHome: string | undefined;

beforeEach(() => {
  oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = writeConfig();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
});

it("F6/F8：空闲完成在 session_start 立即补发一次，正常通道与重启都不重复（BLOCKER #2）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "写文档", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.content).toContain("next: #2");

  // catch-up 不推进 watermark；正常通道必须靠 per-root 去重挡住同一证据
  await h.emit("agent_start", { type: "agent_start" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "bg_run", args: {}, toolCallId: "t1" });
  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle" });
  expect(boundary).toBeUndefined();

  // 重启（同 sidecar/分支）：sent 不满足 10min ⇒ 不补发
  const h2 = makeHarness(cwd, branch, true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h2.sent).toHaveLength(0);
});

it("F38：10 条链同时终结合并为一次投递", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const refs = Array.from({ length: 10 }, (_, i) => `R${i + 1}`);
  setupJobs(cwd, refs.map((id, i) => job({ id, rootId: id, taskId: i + 1, finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: id } })));
  const b = completedWithEvidence(refs, (s) => {
    s.tasks.push({ id: 11, subject: "next", status: "pending" });
    s.nextId = 12;
  });
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.details.jobs).toHaveLength(10);
});

it("F7/F61：boundary 投递 + 紧随 agent_start ack；同证据不重复，重启不补发", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "写文档", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, false);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);            // 非 idle，catch-up 跳过

  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle" });
  expect(boundary?.continue).toBe(true);
  expect(boundary?.entries?.[0]?.customType).toBe("vigil-todo-wake");
  expect(boundary?.entries?.[0]?.content).toContain("next: #2");

  const store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.notifyState).toBe("sent");

  await h.emit("agent_start", { type: "agent_start" });
  store.load();
  expect(store.get("R")?.notifyState).toBe("acked");

  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "bg_run", args: {}, toolCallId: "t2" });
  expect(await h.emit("agent_before_settle", { type: "agent_before_settle" })).toBeUndefined();

  const h2 = makeHarness(cwd, branch, true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h2.sent).toHaveLength(0);           // acked 重启不补发
});

it("F71：boundary 被丢弃后 settle 清除等待，catch-up 绕过 watermark 补发一次", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "写文档", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, false);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle" });
  expect(boundary?.continue).toBe(true);

  await h.emit("agent_settled", { type: "agent_settled" });
  await h.emit("agent_start", { type: "agent_start" });   // 无关 agent_start 不得误 ack
  const store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.notifyState).toBe("sent");

  const root = store.get("R")!;
  store.put({ ...root, notifySentAt: 0 });
  store.save();

  const h2 = makeHarness(cwd, branch, true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h2.sent).toHaveLength(1);
});

it("resume 命令显式 sweep 并受预算约束地唤醒 next（BLOCKER #10）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "继续", status: "pending" }];
  b.nextId = 2;
  b.counters.halted = true;
  b.counters.haltedAt = 10;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h.sent).toHaveLength(0);

  await h.runCommand("vigil-todo", "resume");
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.content).toContain("next: #1");
});
