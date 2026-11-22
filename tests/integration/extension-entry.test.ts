import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import vigilTodo from "../../extensions/vigil-todo.js";
import { replayBranch } from "../../src/board/replay.js";
import { emptyBoard, type BoardState } from "../../src/board/types.js";
import { createJobStore, runDir } from "../../src/jobs/store.js";
import { readStartStamp } from "../../src/jobs/spawn.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { WAKE_CUSTOM_TYPE } from "../../src/wake/compose.js";

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

function makeHarness(
  cwd: string, branch: unknown[], idle = true, sessionId = "S",
  opts: {
    hasUI?: boolean; allTools?: any[]; executeTool?: (name: string, args: unknown) => Promise<any>;
    getSettings?: () => any; sendMessageThrows?: boolean; shortcutThrows?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const commandDefs = new Map<string, any>();
  const toolDefs = new Map<string, any>();
  const shortcuts = new Map<string, (ctx: any) => unknown>();
  const widgets: (string | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  const sent: any[] = [];
  const notifications: string[] = [];
  let isIdle = idle;
  const hasUI = opts.hasUI ?? false;
  const ctx = {
    cwd, hasUI, mode: "text",
    ui: {
      notify: (msg: string) => { notifications.push(msg); },
      setWidget: (key?: string) => { widgets.push(key); },
      setStatus: (_key: string, text?: string) => { statuses.push(text); },
    },
    isIdle: () => isIdle,
    executeTool: opts.executeTool ?? (async () => ({
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details: {}, structuredContent: { exit_code: 0 } },
    })),
    sessionManager: {
      getSessionId: () => sessionId,
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
    registerTool: (def: any) => { toolDefs.set(def.name, def); },
    registerCommand: (name: string, opts: any) => { commands.set(name, opts.handler); commandDefs.set(name, opts); },
    registerShortcut: (key: string, options: any) => {
      if (opts.shortcutThrows) throw new Error("invalid key");
      shortcuts.set(key, options.handler);
    },
    getAllTools: () => opts.allTools ?? [{ name: "todo", sourceInfo: { source: "pi-kit" } }],
    getSettings: () => opts.getSettings ? opts.getSettings() : {},
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
    sendMessage: (message: any, options: any) => {
      if (opts.sendMessageThrows) throw new Error("send boom");
      sent.push({ message, options });
      return Promise.resolve();
    },
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
  let callSeq = 0;
  const runTool = async (name: string, params: Record<string, unknown>): Promise<any> => {
    const def = toolDefs.get(name);
    if (!def) throw new Error(`tool ${name} not registered`);
    return def.execute(`call-${callSeq++}`, params, undefined, undefined, ctx);
  };
  const setIdle = (v: boolean) => { isIdle = v; };
  return {
    api, emit, runCommand, runTool, sent, notifications, toolDefs, shortcuts, widgets, statuses, commandDefs, setIdle, ctx,
  };
}

const waitForFinalized = async (cwd: string, count: number): Promise<void> => {
  for (let i = 0; i < 5000; i++) {
    const store = createJobStore(runDir(cwd));
    store.load();
    if (store.all().filter((j) => j.id === j.rootId && j.finalized).length >= count) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${count} finalized roots`);
};

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
  process.env.XDG_CONFIG_HOME = writeConfig(250);
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
});

it("F8：catch-up 在 session_start 立即补发一次，正常通道与重启都不重复（BLOCKER #2）", async () => {
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
  const snaps = branch.filter((e: any) => e?.type === "custom" && e.customType === "rpiv-todo-state") as any[];
  expect(snaps.at(-1)?.data.counters.turnsUsed).toBe(1);   // catch-up 也计入保险丝（MAJOR #3）

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

it("catch-up 对 10 条已终结链也只发一条（per-root 去重）", async () => {
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

it("F6：真实作业 exit → onJobExit → 250ms 合并窗口单次投递（MINOR #5）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, []);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "跑", status: "in_progress", inProgressSince: 0 },
    { id: 2, subject: "next", status: "pending" },
  ];
  b.nextId = 3;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);

  const r = await h.runTool("bg_run", { command: "printf 'ok\\n'", task_id: 1 });
  expect(r.isError).toBeFalsy();
  await waitForFinalized(cwd, 1);

  await vi.advanceTimersByTimeAsync(249);
  expect(h.sent).toHaveLength(0);              // 合并窗口未到
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sent).toHaveLength(1);              // ≤1s，且只一次
  expect(h.sent[0].message.content).toContain("next: #2");
});

it("F38：10 个真实作业在 250ms 窗口内合并为一条投递（MINOR #5）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, []);
  const b = emptyBoard();
  b.tasks = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, subject: `t${i + 1}`, status: "in_progress" as const, inProgressSince: 0,
  }));
  b.nextId = 11;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);

  for (let i = 1; i <= 10; i++) {
    const r = await h.runTool("bg_run", { command: "printf 'ok\\n'", task_id: i });
    expect(r.isError).toBeFalsy();
  }
  await waitForFinalized(cwd, 10);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.details.jobs).toHaveLength(10);
});

it("F10：同 cwd 两会话的通知各回各家（MINOR #8）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [
    job({ id: "A", rootId: "A", sessionId: "SA" }),
    job({ id: "B", rootId: "B", sessionId: "SB" }),
  ]);
  const hA = makeHarness(cwd, [snapshot(completedWithEvidence(["A"]))], true, "SA");
  const hB = makeHarness(cwd, [snapshot(completedWithEvidence(["B"]))], true, "SB");
  vigilTodo(hA.api);
  vigilTodo(hB.api);
  await hA.emit("session_start", { type: "session_start", reason: "startup" });
  await hB.emit("session_start", { type: "session_start", reason: "startup" });
  expect(hA.sent).toHaveLength(1);
  expect(hA.sent[0].message.details.jobs).toEqual(["A"]);
  expect(hB.sent).toHaveLength(1);
  expect(hB.sent[0].message.details.jobs).toEqual(["B"]);
});

it("F72/F74：4 次失败只投递一次，chainFinal 恰一条且带日志尾（MINOR #7）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "fail.log");
  writeFileSync(log, "boom-tail");
  const ids = ["R", "a2", "a3", "a4"];
  setupJobs(cwd, ids.map((id, i) => job({
    id, rootId: "R", retryOf: i ? ids[i - 1] : undefined, attempt: i + 1,
    status: "failed", exitCode: 1, endedAt: 10 + i, logPath: log,
    finalized: false, evidenceApplied: false, notifyState: "pending",
    finalResult: undefined, taskId: 1, sessionId: "S",
  })));
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "跑", status: "in_progress", jobs: ["R"], inProgressSince: 0,
    evidence: [100, 200, 300].map((at) => ({
      ok: false, kind: "job" as const, origin: "async" as const, chainFinal: false,
      at, known: true, fp: "unknown" as const, ref: "R",
    })),
  }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.details.jobs).toEqual(["R"]);
  expect(h.sent[0].message.content).toContain("boom-tail");
  const snaps = branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[];
  const finals = (snaps.at(-1)?.data.tasks[0].evidence as any[]).filter((e) => e.chainFinal);
  expect(finals).toHaveLength(1);
});

it("/bg k 需二次确认，/bg tail 可看日志尾（§8.4）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "r.log");
  writeFileSync(log, "line1\nline2\nline3");
  setupJobs(cwd, [job({ id: "R", status: "failed", exitCode: 1, endedAt: 2, logPath: log })]);
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("bg", "k R");
  let store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.kill).toBeUndefined();
  expect(h.notifications.join("\n")).toContain("confirm");

  await h.runCommand("bg", "k R confirm");
  store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.kill?.requestedBy).toBe("external");

  await h.runCommand("bg", "tail R");
  expect(h.notifications.join("\n")).toContain("line3");
});

it("恢复作业并入单 timer，不产生每作业 3s 轮询（MAJOR #4）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "跑", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(vi.getTimerCount()).toBe(1);   // 只有扩展的单 timer
  await vi.advanceTimersByTimeAsync(1000);   // 非 halted 的正常探活 tick 也走 runSweep/gc
  expect(vi.getTimerCount()).toBe(1);
});

it("halted 时 recovered 探活仍执行，残留退出不被拖到 resume 后（MINOR）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const pid = child.pid;
    if (pid === undefined) throw new Error("sleep spawned without pid");
    const stamp = readStartStamp(pid);
    setupJobs(cwd, [job({
      id: "R", pid, startStamp: stamp, status: "running", endedAt: null,
      exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
      taskId: undefined, sessionId: "OTHER",
    })]);
    const b = emptyBoard();
    b.counters.halted = true;
    b.counters.haltedAt = 10;
    const h = makeHarness(cwd, [snapshot(b)], true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(vi.getTimerCount()).toBe(1);   // halted + running ⇒ 仍需单 timer 探活

    child.kill("SIGKILL");
    await new Promise<void>((res) => child.once("exit", () => res()));
    await vi.advanceTimersByTimeAsync(1000);

    const store = createJobStore(runDir(cwd));
    store.load();
    expect(store.get("R")?.status).toBe("failed");
    expect(store.get("R")?.exitCodeKnown).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

it("命令输出清洗恶意 label/command/subject（MINOR #1）", async () => {
  const evil = "\u001b]0;pwned\u0007\u001b[31mRED";
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "r.log");
  writeFileSync(log, evil);
  setupJobs(cwd, [job({
    id: "R", label: evil, command: evil, logPath: log, status: "failed", exitCode: 1,
    endedAt: 2, finalized: true, evidenceApplied: true, notifyState: "acked",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: evil, status: "pending" }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vigil-todo", "");
  await h.runCommand("bg", "");
  await h.runCommand("bg", "k R");
  await h.runCommand("bg", "tail R");
  const out = h.notifications.join("\n");
  expect(out).not.toContain("\u001b");
  expect(out).not.toContain("\u0007");
  expect(out).toContain("RED");
});

it("/bg tail 拒绝 runDir 外的 logPath（MINOR #2）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const secret = join(cwd, "secret.txt");
  writeFileSync(secret, "TOPSECRET");
  setupJobs(cwd, [job({
    id: "R", logPath: secret, status: "failed", exitCode: 1, endedAt: 2,
    finalized: true, evidenceApplied: true, notifyState: "acked",
  })]);
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("bg", "tail R");
  const out = h.notifications.join("\n");
  expect(out).toContain("sidecar 可疑");
  expect(out).not.toContain("TOPSECRET");
});

it("F119：/vigil-todo halt 与 resume 命令入口真实生效", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", status: "failed", exitCode: 1, endedAt: 2, taskId: 1, sessionId: "S",
    retryAt: Date.now() + 60_000, finalized: false, evidenceApplied: true, finalResult: undefined,
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "训练", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const lastSnap = () => (branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[]).at(-1)?.data;
  await h.runCommand("vigil-todo", "halt");
  let store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.kill?.requestedBy).toBe("self");
  expect(store.get("R")?.retryAt).toBeUndefined();
  expect(lastSnap().counters.halted).toBe(true);
  expect(lastSnap().tasks[0].status).toBe("parked");
  expect(lastSnap().tasks[0].park?.reason).toContain("强制中断");

  await h.runCommand("vigil-todo", "resume");
  expect(lastSnap().counters.halted).toBeUndefined();
  expect(h.notifications.join("\n")).toContain("已恢复自主推进");
});

it("F120：配置文件的 guidance 覆盖工具 promptSnippet/promptGuidelines", async () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({
    guidance: { promptSnippet: "CUSTOM SNIPPET", promptGuidelines: ["CUSTOM LINE"] },
  }));
  process.env.XDG_CONFIG_HOME = home;

  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.toolDefs.get("todo")?.promptSnippet).toBe("CUSTOM SNIPPET");
  expect(h.toolDefs.get("todo")?.promptGuidelines).toEqual(["CUSTOM LINE"]);
});

it("扩展全事件与命令路径（覆盖率补强）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "r.log");
  const emptyLog = join(storeDir, "empty.log");
  writeFileSync(log, "line-ok");
  writeFileSync(emptyLog, "");
  setupJobs(cwd, [
    job({
      id: "R", label: "训练", command: "train", logPath: log, status: "failed", exitCode: 1, endedAt: 2,
      finalized: true, evidenceApplied: true, notifyState: "acked", taskId: 1, sessionId: "S",
    }),
    job({
      id: "E", rootId: "E", label: "empty", command: "true", logPath: emptyLog, status: "failed", exitCode: 1,
      endedAt: 2, finalized: true, evidenceApplied: true, notifyState: "acked", taskId: 2, sessionId: "S",
    }),
    job({
      id: "R2", rootId: "R2", label: "backoff", command: "true", logPath: log, status: "failed", exitCode: 1,
      endedAt: 2, retryAt: Date.now() + 60_000, finalized: false, evidenceApplied: true,
      finalResult: undefined, taskId: 2, sessionId: "S",
    }),
  ]);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress", inProgressSince: 0, jobs: ["R"], verify: { kind: "command", command: "true" } },
    { id: 2, subject: "b", status: "pending" },
  ];
  b.nextId = 3;
  b.counters = { turnsUsed: 5, wakeWatermark: 0, renudgeBudget: 1 };
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true, "S", { hasUI: true });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const blocked = await h.emit("tool_call", {
    type: "tool_call", toolName: "todo", input: { action: "update", id: 2, status: "in_progress" }, toolCallId: "t1",
  });
  expect(blocked?.block).toBe(true);
  expect(await h.emit("tool_call", {
    type: "tool_call", toolName: "todo", parentToolCallId: "p",
    input: { action: "update", id: 2, status: "in_progress" }, toolCallId: "t2",
  })).toBeUndefined();
  expect(await h.emit("tool_call", { type: "tool_call", toolName: "read", input: {}, toolCallId: "t3" })).toBeUndefined();

  await h.emit("message_start", { type: "message_start", message: { customType: WAKE_CUSTOM_TYPE, details: { wakeId: "w1" } } });
  await h.emit("message_end", { type: "message_end", message: { customType: WAKE_CUSTOM_TYPE, details: { wakeId: "w1" } } });
  await h.emit("message_start", { type: "message_start", message: { role: "user" } });
  await h.emit("agent_start", { type: "agent_start" });
  await h.emit("agent_settled", { type: "agent_settled" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "bg_run", args: {}, toolCallId: "t4" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "todo", args: { action: "update", status: "parked" }, toolCallId: "t5" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "read", parentToolCallId: "p", args: {}, toolCallId: "t6" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "todo", toolCallId: "t7" });
  await h.emit("tool_execution_end", { type: "tool_execution_end", toolName: "todo", toolCallId: "t5" });

  await h.emit("input", { type: "input", text: "hi", source: "extension" });
  await h.emit("input", { type: "input", text: "hi", source: "rpc" });
  await h.emit("input", { type: "input", text: "hi", source: "interactive" });

  await h.runCommand("vigil-todo", "");
  await h.runCommand("vigil-todo", "doctor");
  await h.runCommand("vigil-todo", "resume");
  await h.runCommand("todos", "");
  await h.runCommand("bg", "");
  await h.runCommand("bg", "k");
  await h.runCommand("bg", "k NOPE");
  await h.runCommand("bg", "k R");
  await h.runCommand("bg", "k R confirm");
  await h.runCommand("bg", "k R confirm");
  await h.runCommand("bg", "tail R");
  await h.runCommand("bg", "tail NOPE");
  await h.runCommand("bg", "tail E");

  const vr = await h.runTool("todo", { action: "verify", id: 1 });
  expect(vr.isError).toBeFalsy();

  for (const handler of h.shortcuts.values()) await handler(h.ctx);
  expect(h.widgets.length).toBeGreaterThan(0);

  await h.emit("session_start", { type: "session_start", reason: "reload" });
  await h.emit("session_compact", { type: "session_compact" });
  await h.emit("session_tree", { type: "session_tree" });
  await h.emit("session_shutdown", { type: "session_shutdown" });
  expect(h.notifications.length).toBeGreaterThan(0);
});

it("启动冲突自检：旧包占位时 notify error 且不 wire", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true, "S", {
    hasUI: true,
    allTools: [{ name: "todo", sourceInfo: { source: "old-package" } }],
  });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.notifications.join("\n")).toContain("其他扩展");
  expect(h.notifications.join("\n")).toContain("不注册事件处理器");
});

it("collapseKey=off 只关折叠键，haltKey 默认仍注册（C4）", async () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({ collapseKey: "off" }));
  process.env.XDG_CONFIG_HOME = home;

  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect([...h.shortcuts.keys()]).toEqual(["alt+h"]);
});

it("haltKey=off 时可关闭一键中断（C4）", async () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({ haltKey: "off" }));
  process.env.XDG_CONFIG_HOME = home;

  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.shortcuts.size).toBe(1);          // 只剩折叠键
  expect(h.shortcuts.has("alt+h")).toBe(false);
});

it("T1 /vt 与 /vigil-todo 共用同一份补全定义", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const a = h.commandDefs.get("vigil-todo").getArgumentCompletions;
  const b = h.commandDefs.get("vt").getArgumentCompletions;
  expect(a).toBe(b);                                    // 同一个函数，杜绝漂移
  expect(a("").map((c: any) => c.value)).toEqual(["halt", "resume", "doctor", "clear"]);
  expect(a("h").map((c: any) => c.value)).toEqual(["halt"]);
  expect(a("r").map((c: any) => c.value)).toEqual(["resume"]);
  expect(a("d").map((c: any) => c.value)).toEqual(["doctor"]);
  expect(a("clear ").map((c: any) => c.value))
    .toEqual(["clear completed", "clear deleted", "clear settled", "clear all"]);
  expect(a("x")).toBeNull();
  for (const p of ["", "h", "r", "d", "x"]) expect(a(p)).toEqual(b(p));
});

it("T2 /bg 动态补全当前 jobs，且不改 board/sidecar", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [
    job({ id: "bg_run", label: "训练", status: "running", endedAt: null, exitCode: null,
      exitCodeKnown: false, pid: process.pid, startStamp: stamp, finalized: false,
      finalResult: undefined, taskId: 1, sessionId: "S" }),
    job({ id: "bg_back", label: "退避", status: "failed", retryAt: Date.now() + 60_000,
      finalized: false, finalResult: undefined, taskId: 2, sessionId: "S" }),
    job({ id: "bg_done", label: "完成" }),
    job({ id: "bg_evil", label: "\u001b]0;pwned\u0007\u001b[31mRED" }),
  ]);
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const comp = h.commandDefs.get("bg").getArgumentCompletions;
  expect(comp("").map((c: any) => c.value)).toEqual(["k", "tail"]);
  expect(comp("k ").map((c: any) => c.label)).toEqual(["bg_run", "bg_back"]);
  expect(comp("k bg_b").map((c: any) => c.label)).toEqual(["bg_back"]);
  expect(comp("tail ").map((c: any) => c.label)).toEqual(["bg_run", "bg_back", "bg_done", "bg_evil"]);
  expect(comp("tail ")[0].value).toBe("tail bg_run");
  const evil = comp("tail ").find((c: any) => c.label === "bg_evil")!;
  expect(evil.description).not.toContain("\u001b");
  expect(evil.description).not.toContain("\u0007");
  expect(evil.description).toContain("RED");

  const path = join(runDir(cwd), "jobs.json");
  const before = readFileSync(path, "utf8");
  comp("k ");
  comp("tail ");
  expect(readFileSync(path, "utf8")).toBe(before);      // 纯读：sidecar 字节不变
  expect(h.commandDefs.get("todos").getArgumentCompletions("")).toBeNull();
});

it("T2 补全在未初始化 / 空 sid / halted 时不抛", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);                                     // 尚未 session_start：store 未 load、sid 空
  const bg = h.commandDefs.get("bg").getArgumentCompletions;
  expect(() => bg("")).not.toThrow();
  expect(bg("").map((c: any) => c.value)).toEqual(["k", "tail"]);
  expect(bg("k ")).toBeNull();
  expect(bg("tail ")).toBeNull();
  expect(h.commandDefs.get("todos").getArgumentCompletions("")).toBeNull();
  expect(h.commandDefs.get("vt").getArgumentCompletions("h").map((c: any) => c.value)).toEqual(["halt"]);

  const b = emptyBoard();
  b.counters.halted = true;
  b.counters.haltedAt = 1;
  const h2 = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(b)], true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "startup" });
  expect(() => h2.commandDefs.get("bg").getArgumentCompletions("k ")).not.toThrow();
  expect(() => h2.commandDefs.get("bg").getArgumentCompletions("tail ")).not.toThrow();
  expect(h2.commandDefs.get("vigil-todo").getArgumentCompletions("r").map((c: any) => c.value))
    .toEqual(["resume"]);
});

it("F123 /vt clear 默认只清 completed+deleted，保留 pending/in_progress/parked 并落快照", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "done", status: "completed", statusSince: 1 },
    { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
    { id: 3, subject: "pending", status: "pending" },
    { id: 4, subject: "running", status: "in_progress", inProgressSince: 0 },
    { id: 5, subject: "parked", status: "parked", park: { reason: "等拍板", at: 1, from: "pending" } },
  ];
  b.nextId = 6;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const before = branch.filter((e: any) => e?.customType === "rpiv-todo-state").length;

  await h.runCommand("vt", "clear");
  expect(h.notifications.at(-1)).toContain("已清理 2");
  expect(replayBranch(branch as never[]).tasks.map((t) => t.id)).toEqual([3, 4, 5]);
  expect(branch.filter((e: any) => e?.customType === "rpiv-todo-state").length).toBe(before + 1);
});

it("F124 /vt clear completed / deleted 各自只清一类", async () => {
  const mk = async (scope: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
    const b = emptyBoard();
    b.tasks = [
      { id: 1, subject: "done", status: "completed", statusSince: 1 },
      { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
    ];
    b.nextId = 3;
    const branch: unknown[] = [snapshot(b)];
    const h = makeHarness(cwd, branch, true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.runCommand("vt", `clear ${scope}`);
    return { replay: replayBranch(branch as never[]), h };
  };
  const completed = await mk("completed");
  expect(completed.replay.tasks.map((t) => t.id)).toEqual([2]);
  expect(completed.h.notifications.at(-1)).toContain("已清理 1");
  const deleted = await mk("deleted");
  expect(deleted.replay.tasks.map((t) => t.id)).toEqual([1]);
});

it("F125 /vt clear all 无 confirm：不删除，回显含 pending/in_progress 的清单", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "待办", status: "pending" },
    { id: 2, subject: "在跑", status: "in_progress", inProgressSince: 0 },
    { id: 3, subject: "等人", status: "parked", park: { reason: "等", at: 1, from: "pending" } },
  ];
  b.nextId = 4;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const before = branch.filter((e: any) => e?.customType === "rpiv-todo-state").length;

  await h.runCommand("vt", "clear all");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("clear all confirm");
  expect(out).toContain("#1 [pending] 待办");
  expect(out).toContain("#2 [in_progress] 在跑");
  expect(out).toContain("#3 [parked] 等人");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(3);
  expect(branch.filter((e: any) => e?.customType === "rpiv-todo-state").length).toBe(before);
});

it("F125 未先看清单直接 clear all confirm：拒绝且不删除", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "done", status: "completed", statusSince: 1 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("vt", "clear all confirm");
  expect(h.notifications.at(-1)).toContain("先 /vt clear all");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(1);
});

it("F126 /vt clear all confirm 有 running/退避链时拒绝并指向 bg_kill / halt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "在跑", status: "in_progress", jobs: ["R"], inProgressSince: 0 },
    { id: 2, subject: "待办", status: "pending" },
  ];
  b.nextId = 3;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear all");
  await h.runCommand("vt", "clear all confirm");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("bg_kill");
  expect(out).toContain("/vigil-todo halt");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(2);
});

it("F127 /vt clear all confirm 无作业：全清并落快照", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "completed", statusSince: 1 },
    { id: 2, subject: "b", status: "pending" },
    { id: 3, subject: "c", status: "parked", park: { reason: "等", at: 1, from: "pending" } },
  ];
  b.nextId = 4;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear all");
  await h.runCommand("vt", "clear all confirm");
  expect(h.notifications.at(-1)).toContain("已清理 3");
  expect(replayBranch(branch as never[]).tasks).toEqual([]);
  const last = (branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[]).at(-1)?.data;
  expect(last.tasks).toEqual([]);
});

it("F128 清理后 catch-up 不再投影/补发已 purge 的链", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", taskId: 1, sessionId: "S", notifyState: "sent", notifySentAt: 0,
    finalized: true, evidenceApplied: true,
    finalResult: { ok: true, note: "done", trigger: "external", at: 2, jobId: "R" },
  })]);
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "done", status: "completed", statusSince: 1, jobs: ["R"],
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "R", exitCode: 0 }],
  }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("vt", "clear");
  expect(replayBranch(branch as never[]).tasks).toEqual([]);
  const store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.purged).toBe(true);

  const h2 = makeHarness(cwd, branch, true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h2.sent).toHaveLength(0);
  expect(replayBranch(branch as never[]).tasks).toEqual([]);
});

it("F129 绑 running 作业的任务在任意范围跳过并在输出列出 id", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: 1, sessionId: "OTHER",
  })]);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "在跑", status: "completed", jobs: ["R"], statusSince: 1 },
    { id: 2, subject: "done", status: "completed", statusSince: 1 },
  ];
  b.nextId = 3;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear completed");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("已清理 1");
  expect(out).toContain("#1");
  expect(out).toContain("running");
  expect(replayBranch(branch as never[]).tasks.map((t) => t.id)).toEqual([1]);
});

it("F130 无可清历史时明确提示，不静默", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "待办", status: "pending" }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("vt", "clear");
  expect(h.notifications.at(-1)).toContain("没有可清理的历史任务");
});

it("F132 /vt clear 与 /vigil-todo clear 行为完全一致", async () => {
  const mk = async (name: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
    const b = emptyBoard();
    b.tasks = [
      { id: 1, subject: "done", status: "completed", statusSince: 1 },
      { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
      { id: 3, subject: "pending", status: "pending" },
    ];
    b.nextId = 4;
    const branch: unknown[] = [snapshot(b)];
    const h = makeHarness(cwd, branch, true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.runCommand(name, "clear");
    return { tasks: replayBranch(branch as never[]).tasks, out: h.notifications.at(-1) };
  };
  const a = await mk("vt");
  const b = await mk("vigil-todo");
  expect(a.tasks).toEqual(b.tasks);
  expect(a.out).toBe(b.out);
  expect(a.tasks.map((t) => t.id)).toEqual([3]);
});

it("C4 halt 快捷键真实中断并落快照", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", status: "failed", exitCode: 1, endedAt: 2, taskId: 1, sessionId: "S",
    retryAt: Date.now() + 60_000, finalized: false, evidenceApplied: true, finalResult: undefined,
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "跑", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.shortcuts.get("alt+h")!(h.ctx);
  const last = (branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[]).at(-1)?.data;
  expect(last.counters.halted).toBe(true);
  expect(last.tasks[0].status).toBe("parked");
});

it("C1/C3/C6：/vt 等价 /vigil-todo，无参数带快捷提示，命令描述自文档化", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  expect([...h.commandDefs.keys()].sort()).toEqual(["bg", "todos", "vigil-todo", "vt"]);
  await h.runCommand("vt", "halt");
  expect((branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[]).at(-1)?.data.counters.halted).toBe(true);
  await h.runCommand("vt", "resume");
  await h.runCommand("vt", "");
  expect(h.notifications.at(-1)).toContain("halt 停");
  expect(h.notifications.at(-1)).toContain("resume 继续");
  expect(h.notifications.at(-1)).toContain("clear 清理");
  await h.runCommand("vigil-todo", "");
  expect(h.notifications.at(-1)).toContain("doctor 自检");

  expect(h.commandDefs.get("vigil-todo").description).toContain("halt 立即停止");
  expect(h.commandDefs.get("vigil-todo").description).toContain("/vt");
  expect(h.commandDefs.get("vt").description).toContain("/vigil-todo");
  expect(h.commandDefs.get("todos").description).toContain("/bg");
  expect(h.commandDefs.get("bg").description).toContain("/bg k <id>");
});

it("C2 状态栏随看板刷新，空闲清空，shutdown 移除", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "completed", statusSince: 1 },
    { id: 2, subject: "b", status: "pending" },
  ];
  b.nextId = 3;
  const h = makeHarness(cwd, [snapshot(b)], true, "S", { hasUI: true });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.statuses.at(-1)).toBe("vigil ✓ 1/2");

  await h.runCommand("vigil-todo", "halt");
  expect(h.statuses.at(-1)).toBe("vigil ⏸ halted");
  await h.runCommand("vigil-todo", "resume");
  expect(h.statuses.at(-1)).toBe("vigil ✓ 1/2");

  await h.emit("session_shutdown", { type: "session_shutdown" });
  expect(h.statuses.at(-1)).toBeUndefined();

  const runningCwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(runningCwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: undefined, sessionId: "S",
  })]);
  const h2 = makeHarness(runningCwd, [snapshot(emptyBoard())], true, "S", { hasUI: true });
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h2.statuses.at(-1)).toBe("vigil ● 1 job");
  expect(vi.getTimerCount()).toBe(1);       // 状态栏复用既有 tick，不新增定时器
});

it("配置缺失/损坏/不可序列化 settings 时仍能启动", async () => {
  const broken = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(broken, "pi-kit"), { recursive: true });
  writeFileSync(join(broken, "pi-kit", "config.json"), "{broken");
  process.env.XDG_CONFIG_HOME = broken;
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true, "S", {
    getSettings: () => { const o: any = {}; o.vigilTodo = o; return o; },
  });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.toolDefs.size).toBe(4);

  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  const h2 = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h2.toolDefs.size).toBe(4);
});

it("XDG 未设置时回退 HOME/.config", async () => {
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-home-"));
  mkdirSync(join(home, ".config", "pi-kit"), { recursive: true });
  writeFileSync(join(home, ".config", "pi-kit", "config.json"), "{}");
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(h.toolDefs.size).toBe(4);
  } finally {
    process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  }
});

it("非法 collapseKey 注册失败不致命", async () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({ collapseKey: "!bad" }));
  process.env.XDG_CONFIG_HOME = home;
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true, "S", {
    shortcutThrows: true,
  });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.shortcuts.size).toBe(0);
});

it("sendMessage 抛错时 notify 并等待 catch-up", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({ id: "R", notifyState: "pending" })]);
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "a", status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "R", exitCode: 0 }],
  }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true, "S", { hasUI: true, sendMessageThrows: true });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);
  expect(h.notifications.join("\n")).toContain("唤醒发送失败");
});

it("catch-up 达 maxTurns 不发；halted boundary 不续跑", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({ id: "R", notifyState: "pending" })]);
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "a", status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "R", exitCode: 0 }],
  }];
  b.nextId = 2;
  b.counters.turnsUsed = DEFAULTS.maxTurns;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);

  const b2 = emptyBoard();
  b2.tasks = [{ id: 1, subject: "x", status: "pending" }];
  b2.nextId = 2;
  b2.counters.halted = true;
  b2.counters.haltedAt = 1;
  const h2 = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(b2)], false);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "startup" });
  expect(await h2.emit("agent_before_settle", { type: "agent_before_settle" })).toBeUndefined();
});

it("spawn 失败时 bg_run 返回 isError", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  rmSync(cwd, { recursive: true, force: true });
  const r = await h.runTool("bg_run", { command: "true", task_id: 1 });
  expect(r.isError).toBe(true);
});

it("halt 杀 running 作业（escalate 路径）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  try {
    const stamp = readStartStamp(pid);
    setupJobs(cwd, [job({
      id: "R", pid, startStamp: stamp, status: "running", endedAt: null,
      exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
      taskId: 1, sessionId: "S",
    })]);
    const b = emptyBoard();
    b.tasks = [{ id: 1, subject: "t", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
    b.nextId = 2;
    const h = makeHarness(cwd, [snapshot(b)], true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    await h.runCommand("vigil-todo", "halt");
    await exited;
    const store = createJobStore(runDir(cwd));
    store.load();
    expect(store.get("R")?.kill?.requestedBy).toBe("self");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

it("shutdown 清理单 timer 与合并 timer", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, []);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const r = await h.runTool("bg_run", { command: "true", task_id: 1 });
  expect(r.isError).toBeFalsy();
  await waitForFinalized(cwd, 1);
  await h.emit("session_shutdown", { type: "session_shutdown" });
  expect(vi.getTimerCount()).toBe(0);
});

it("A1 respawn 失败的 park 落入分支快照，重放读回 parked（磁盘级）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", rootId: "R", command: "", status: "failed", exitCode: 1, endedAt: 2,
    retryAt: 0, finalized: false, evidenceApplied: false, notifyState: "acked",
    finalResult: undefined, taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "跑", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const replay = replayBranch(branch as never[]);
  expect(replay.tasks[0].status).toBe("parked");
  expect(replay.tasks[0].park?.reason).toBe("spawn failed");
  const store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.retryAt).toBeUndefined();
});

it("A2 非 owner 残留作业退出：fpEnd 落盘（autofill/finalize 均 early-return）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", pid: 999_999, status: "running", endedAt: null, exitCode: null, exitCodeKnown: false,
    finalized: false, finalResult: undefined, taskId: undefined, sessionId: "OTHER",
    cwd: process.cwd(), fpStart: "abc",     // 真实 git 工作区，fpEnd 可采集
  })]);
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true, "S");
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await vi.advanceTimersByTimeAsync(1000);
  const store = createJobStore(runDir(cwd));
  store.load();
  expect(store.get("R")?.status).toBe("failed");
  expect(typeof store.get("R")?.fpEnd).toBe("string");
});

it("B3 shutdown 不杀作业（跨重启语义），但记录完整、下一实例可 halt 到进程消失", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  try {
    const stamp = readStartStamp(pid);
    setupJobs(cwd, [job({
      id: "R", pid, startStamp: stamp, status: "running", endedAt: null,
      exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
      taskId: 1, sessionId: "S",
    })]);
    const h = makeHarness(cwd, [snapshot(emptyBoard())], true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    // 不是孤儿：仍由 sidecar 的 pid + startStamp 跟踪
    expect(() => process.kill(pid, 0)).not.toThrow();
    const store = createJobStore(runDir(cwd));
    store.load();
    expect(store.get("R")?.status).toBe("running");
    expect(store.get("R")?.startStamp).toBe(stamp);

    const h2 = makeHarness(cwd, [snapshot(emptyBoard())], true);
    vigilTodo(h2.api);
    await h2.emit("session_start", { type: "session_start", reason: "resume" });
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    await h2.runCommand("vt", "halt");
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

it("finalizeTerminated 对 killed 链写 note=killed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", status: "killed", exitCode: null, exitCodeKnown: false, endedAt: 2,
    kill: { requestedBy: "external", at: 1 }, finalized: false, evidenceApplied: false,
    finalResult: undefined, taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const snaps = branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[];
  const finals = (snaps.at(-1)?.data.tasks[0].evidence as any[]).filter((e) => e.chainFinal);
  expect(finals).toHaveLength(1);
  expect(finals[0].note).toBe("killed");
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.content).toContain("killed");
});
