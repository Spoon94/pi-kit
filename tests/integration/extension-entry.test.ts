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
  id: "R", label: "regression", command: "npm test", logPath: "/tmp/r.log", cwd: "/tmp", pid: 1,
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

it("F8: catch-up re-sends once immediately at session_start; neither the normal channel nor a restart duplicates it (BLOCKER #2)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "write docs", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].message.content).toContain("next: #2");
  const snaps = branch.filter((e: any) => e?.type === "custom" && e.customType === "rpiv-todo-state") as any[];
  expect(snaps.at(-1)?.data.counters.turnsUsed).toBe(1);   // catch-up also counts against the fuse (MAJOR #3)

  // catch-up does not advance the watermark; the normal channel must dedupe the same evidence per root
  await h.emit("agent_start", { type: "agent_start" });
  await h.emit("tool_execution_start", { type: "tool_execution_start", toolName: "bg_run", args: {}, toolCallId: "t1" });
  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle" });
  expect(boundary).toBeUndefined();

  // Restart (same sidecar/branch): sent within 10min ⇒ no resend
  const h2 = makeHarness(cwd, branch, true);
  vigilTodo(h2.api);
  await h2.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h2.sent).toHaveLength(0);
});

it("catch-up sends only one message even for 10 settled chains (per-root dedup)", async () => {
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

it("F7/F61: boundary delivery + ack on the following agent_start; same evidence is not repeated, restart does not resend", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "write docs", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, false);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.sent).toHaveLength(0);            // Not idle; catch-up skipped

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
  expect(h2.sent).toHaveLength(0);           // acked; restart does not resend
});

it("F71: dropped boundary clears the wait at settle; catch-up bypasses the watermark and resends once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job()]);
  const b = completedWithEvidence(["R"], (s) => {
    s.tasks.push({ id: 2, subject: "write docs", status: "pending" });
    s.nextId = 3;
  });
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, false);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  const boundary = await h.emit("agent_before_settle", { type: "agent_before_settle" });
  expect(boundary?.continue).toBe(true);

  await h.emit("agent_settled", { type: "agent_settled" });
  await h.emit("agent_start", { type: "agent_start" });   // Unrelated agent_start must not ack by mistake
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

it("resume command explicitly sweeps and wakes next within budget (BLOCKER #10)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "continue", status: "pending" }];
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

it("F6: real job exit → onJobExit → single delivery in the 250ms merge window (MINOR #5)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, []);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "run", status: "in_progress", inProgressSince: 0 },
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
  expect(h.sent).toHaveLength(0);              // merge window not reached
  await vi.advanceTimersByTimeAsync(1);
  expect(h.sent).toHaveLength(1);              // ≤1s and exactly once
  expect(h.sent[0].message.content).toContain("next: #2");
});

it("F38: 10 real jobs merge into one delivery within the 250ms window (MINOR #5)", async () => {
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

it("F10: notifications for two sessions in the same cwd go to the right session each (MINOR #8)", async () => {
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

it("F72/F74: 6 failures deliver once, exactly one chainFinal with the log tail (MINOR #7)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "fail.log");
  writeFileSync(log, "boom-tail");
  const ids = ["R", "a2", "a3", "a4", "a5", "a6"];
  setupJobs(cwd, ids.map((id, i) => job({
    id, rootId: "R", retryOf: i ? ids[i - 1] : undefined, attempt: i + 1,
    status: "failed", exitCode: 1, endedAt: 10 + i, logPath: log,
    finalized: false, evidenceApplied: false, notifyState: "pending",
    finalResult: undefined, taskId: 1, sessionId: "S",
  })));
  const b = emptyBoard();
  b.tasks = [{
    id: 1, subject: "run", status: "in_progress", jobs: ["R"], inProgressSince: 0,
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

it("/bg k requires two-step confirmation; /bg tail shows the log tail (§8.4)", async () => {
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

it("Recovered jobs share a single timer; no 3s poll per job (MAJOR #4)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "run", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(vi.getTimerCount()).toBe(1);   // Only the extension's single timer
  await vi.advanceTimersByTimeAsync(1000);   // A normal liveness tick while not halted also runs runSweep/gc
  expect(vi.getTimerCount()).toBe(1);
});

it("When halted, recovered liveness probes still run; leftover exits are not deferred until resume (MINOR)", async () => {
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
    expect(vi.getTimerCount()).toBe(1);   // halted + running ⇒ still needs the single timer

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

it("Command output sanitizes malicious label/command/subject (MINOR #1)", async () => {
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

it("/bg tail refuses a logPath outside runDir (MINOR #2)", async () => {
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
  expect(out).toContain("suspicious sidecar");
  expect(out).not.toContain("TOPSECRET");
});

it("F119: /vigil-todo halt and resume command entry points take real effect", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", status: "failed", exitCode: 1, endedAt: 2, taskId: 1, sessionId: "S",
    retryAt: Date.now() + 60_000, finalized: false, evidenceApplied: true, finalResult: undefined,
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "training", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
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
  expect(lastSnap().tasks[0].park?.reason).toContain("halted by user");

  await h.runCommand("vigil-todo", "resume");
  expect(lastSnap().counters.halted).toBeUndefined();
  expect(lastSnap().tasks[0].status).toBe("pending");
  expect(lastSnap().tasks[0].park).toBeUndefined();
  expect(h.notifications.join("\n")).toContain("Autonomous progress resumed");
  expect(h.notifications.join("\n")).toContain("1 halted tasks back to pending");
});

it("F120: config file guidance overrides tool promptSnippet/promptGuidelines", async () => {
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

it("All extension events and command paths (coverage reinforcement)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const storeDir = runDir(cwd);
  mkdirSync(storeDir, { recursive: true });
  const log = join(storeDir, "r.log");
  const emptyLog = join(storeDir, "empty.log");
  writeFileSync(log, "line-ok");
  writeFileSync(emptyLog, "");
  setupJobs(cwd, [
    job({
      id: "R", label: "training", command: "train", logPath: log, status: "failed", exitCode: 1, endedAt: 2,
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

it("Startup conflict self-check: old package occupying the tool notifies an error and does not wire", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const h = makeHarness(cwd, [snapshot(emptyBoard())], true, "S", {
    hasUI: true,
    allTools: [{ name: "todo", sourceInfo: { source: "old-package" } }],
  });
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.notifications.join("\n")).toContain("another extension");
  expect(h.notifications.join("\n")).toContain("registers no event handlers");
});

it("collapseKey=off disables only the collapse key; haltKey still registered by default (C4)", async () => {
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

it("haltKey=off disables one-tap halt (C4)", async () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-ext-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), JSON.stringify({ haltKey: "off" }));
  process.env.XDG_CONFIG_HOME = home;

  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.shortcuts.size).toBe(1);          // only the collapse key remains
  expect(h.shortcuts.has("alt+h")).toBe(false);
});

it("T1 /vt and /vigil-todo share the same completion definition", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const a = h.commandDefs.get("vigil-todo").getArgumentCompletions;
  const b = h.commandDefs.get("vt").getArgumentCompletions;
  expect(a).toBe(b);                                    // the same function, so they cannot drift
  expect(a("").map((c: any) => c.value)).toEqual(["halt", "resume", "doctor", "clear"]);
  expect(a("h").map((c: any) => c.value)).toEqual(["halt"]);
  expect(a("r").map((c: any) => c.value)).toEqual(["resume"]);
  expect(a("d").map((c: any) => c.value)).toEqual(["doctor"]);
  expect(a("clear ").map((c: any) => c.value))
    .toEqual(["clear completed", "clear deleted", "clear settled"]);
  expect(a("x")).toBeNull();
  for (const p of ["", "h", "r", "d", "x"]) expect(a(p)).toEqual(b(p));
});

it("T2 /bg dynamically completes current jobs without modifying board/sidecar", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [
    job({ id: "bg_run", label: "training", status: "running", endedAt: null, exitCode: null,
      exitCodeKnown: false, pid: process.pid, startStamp: stamp, finalized: false,
      finalResult: undefined, taskId: 1, sessionId: "S" }),
    job({ id: "bg_back", label: "backoff", status: "failed", retryAt: Date.now() + 60_000,
      finalized: false, finalResult: undefined, taskId: 2, sessionId: "S" }),
    job({ id: "bg_done", label: "completed" }),
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
  expect(readFileSync(path, "utf8")).toBe(before);      // pure read: sidecar bytes unchanged
  expect(h.commandDefs.get("todos").getArgumentCompletions("")).toBeNull();
});

it("T2 completions do not throw when uninitialized / empty sid / halted", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "vigil-ext-")), [snapshot(emptyBoard())], true);
  vigilTodo(h.api);                                     // not yet session_start: store not loaded, sid empty
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

it("F123 /vt clear by default clears only completed+deleted, keeps pending/in_progress/parked and writes a snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "done", status: "completed", statusSince: 1 },
    { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
    { id: 3, subject: "pending", status: "pending" },
    { id: 4, subject: "running", status: "in_progress", inProgressSince: 0 },
    { id: 5, subject: "parked", status: "parked", park: { reason: "waiting decision", at: 1, from: "pending" } },
  ];
  b.nextId = 6;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const before = branch.filter((e: any) => e?.customType === "rpiv-todo-state").length;

  await h.runCommand("vt", "clear");
  expect(h.notifications.at(-1)).toContain("cleared 2 tasks");
  expect(replayBranch(branch as never[]).tasks.map((t) => t.id)).toEqual([3, 4, 5]);
  expect(branch.filter((e: any) => e?.customType === "rpiv-todo-state").length).toBe(before + 1);
});

it("F124 /vt clear completed / deleted each clears only one kind", async () => {
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
  expect(completed.h.notifications.at(-1)).toContain("cleared 1 tasks");
  const deleted = await mk("deleted");
  expect(deleted.replay.tasks.map((t) => t.id)).toEqual([1]);
});

it("F125 /vt clear all is rejected: lists the three allowed scopes, deletes nothing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "done", status: "completed", statusSince: 1 },
    { id: 2, subject: "todo item", status: "pending" },
  ];
  b.nextId = 3;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  const before = branch.filter((e: any) => e?.customType === "rpiv-todo-state").length;

  await h.runCommand("vt", "clear all");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("clear all is not supported");
  expect(out).toContain("completed / deleted / settled");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(2);
  expect(branch.filter((e: any) => e?.customType === "rpiv-todo-state").length).toBe(before);
});

it("F126 /vt clear all confirm is likewise rejected; confirm is not offered either", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "done", status: "completed", statusSince: 1 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear all confirm");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("clear all is not supported");
  expect(out).toContain("completed / deleted / settled");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(1);
});

it("F127 with pending/in_progress/parked on the board, /vt clear keeps all three and clears only completed+deleted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "done", status: "completed", statusSince: 1 },
    { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
    { id: 3, subject: "todo item", status: "pending" },
    { id: 4, subject: "running task", status: "in_progress", inProgressSince: 0 },
    { id: 5, subject: "waiting", status: "parked", park: { reason: "waiting decision", at: 1, from: "pending" } },
  ];
  b.nextId = 6;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear");
  expect(h.notifications.at(-1)).toContain("cleared 2 tasks");
  const replayed = replayBranch(branch as never[]).tasks;
  expect(replayed.map((t) => [t.id, t.status])).toEqual([
    [3, "pending"], [4, "in_progress"], [5, "parked"],
  ]);
  const last = (branch.filter((e: any) => e?.customType === "rpiv-todo-state") as any[]).at(-1)?.data;
  expect(last.tasks.map((t: any) => t.id)).toEqual([3, 4, 5]);
});

it("parked / pending are never cleared under any allowed scope", async () => {
  const run = async (scope: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
    const b = emptyBoard();
    b.tasks = [
      { id: 1, subject: "done", status: "completed", statusSince: 1 },
      { id: 2, subject: "gone", status: "deleted", statusSince: 1 },
      { id: 3, subject: "todo item", status: "pending" },
      { id: 4, subject: "waiting", status: "parked", park: { reason: "waiting decision", at: 1, from: "pending" } },
    ];
    b.nextId = 5;
    const branch: unknown[] = [snapshot(b)];
    const h = makeHarness(cwd, branch, true);
    vigilTodo(h.api);
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.runCommand("vt", scope ? `clear ${scope}` : "clear");
    return replayBranch(branch as never[]).tasks.map((t) => [t.id, t.status]);
  };
  for (const scope of ["", "completed", "deleted", "settled"]) {
    const tasks = await run(scope);
    expect(tasks, scope || "default").toContainEqual([3, "pending"]);
    expect(tasks, scope || "default").toContainEqual([4, "parked"]);
  }
});

it("Unknown scope is rejected and the allowed scopes are listed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "done", status: "completed", statusSince: 1 }];
  b.nextId = 2;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("vt", "clear weird");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("clear weird is not supported");
  expect(out).toContain("completed / deleted / settled");
  expect(replayBranch(branch as never[]).tasks).toHaveLength(1);
});

it("F128 after cleanup, catch-up no longer projects/resends purged chains", async () => {
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

it("F129 tasks bound to running jobs are skipped in any scope and their ids are listed in the output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const stamp = readStartStamp(process.pid);
  setupJobs(cwd, [job({
    id: "R", pid: process.pid, startStamp: stamp, status: "running", endedAt: null,
    exitCode: null, exitCodeKnown: false, finalized: false, finalResult: undefined,
    taskId: 1, sessionId: "OTHER",
  })]);
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "running task", status: "completed", jobs: ["R"], statusSince: 1 },
    { id: 2, subject: "done", status: "completed", statusSince: 1 },
  ];
  b.nextId = 3;
  const branch: unknown[] = [snapshot(b)];
  const h = makeHarness(cwd, branch, true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });

  await h.runCommand("vt", "clear completed");
  const out = h.notifications.at(-1)!;
  expect(out).toContain("cleared 1 tasks");
  expect(out).toContain("#1");
  expect(out).toContain("running");
  expect(replayBranch(branch as never[]).tasks.map((t) => t.id)).toEqual([1]);
});

it("F130 explicitly reports when there is no history to clear, never silently", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "todo item", status: "pending" }];
  b.nextId = 2;
  const h = makeHarness(cwd, [snapshot(b)], true);
  vigilTodo(h.api);
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  await h.runCommand("vt", "clear");
  expect(h.notifications.at(-1)).toContain("no history tasks to clear");
});

it("F132 /vt clear and /vigil-todo clear behave identically", async () => {
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

it("C4 halt shortcut really halts and writes a snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", status: "failed", exitCode: 1, endedAt: 2, taskId: 1, sessionId: "S",
    retryAt: Date.now() + 60_000, finalized: false, evidenceApplied: true, finalResult: undefined,
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "run", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
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

it("C1/C3/C6: /vt is equivalent to /vigil-todo; no args shows quick hints; command description is self-documenting", async () => {
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
  expect(h.notifications.at(-1)).toContain("halt stop");
  expect(h.notifications.at(-1)).toContain("resume continue");
  expect(h.notifications.at(-1)).toContain("clear purge");
  await h.runCommand("vigil-todo", "");
  expect(h.notifications.at(-1)).toContain("doctor self-check");

  expect(h.commandDefs.get("vigil-todo").description).toContain("halt stops all background work immediately");
  expect(h.commandDefs.get("vigil-todo").description).toContain("/vt");
  expect(h.commandDefs.get("vt").description).toContain("/vigil-todo");
  expect(h.commandDefs.get("todos").description).toContain("/bg");
  expect(h.commandDefs.get("bg").description).toContain("/bg k <id>");
});

it("C2 status bar refreshes with the board, clears when idle, removed at shutdown", async () => {
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
  expect(vi.getTimerCount()).toBe(1);       // the status bar reuses the existing tick; no new timer
});

it("Starts even when config is missing, corrupt, or settings are unserializable", async () => {
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

it("Falls back to HOME/.config when XDG is unset", async () => {
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

it("Invalid collapseKey registration failure is not fatal", async () => {
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

it("notify and wait for catch-up when sendMessage throws", async () => {
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
  expect(h.notifications.join("\n")).toContain("wake send failed");
});

it("catch-up does not send at maxTurns; halted boundary does not continue", async () => {
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

it("bg_run returns isError when spawn fails", async () => {
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

it("halt kills running jobs (escalate path)", async () => {
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

it("shutdown clears the single timer and merge timer", async () => {
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

it("A1 respawn-failure park lands in the branch snapshot; replay reads back parked (disk level)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", rootId: "R", command: "", status: "failed", exitCode: 1, endedAt: 2,
    retryAt: 0, finalized: false, evidenceApplied: false, notifyState: "acked",
    finalResult: undefined, taskId: 1, sessionId: "S",
  })]);
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "run", status: "in_progress", jobs: ["R"], inProgressSince: 0 }];
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

it("A2 non-owner leftover job exit: fpEnd persisted (autofill/finalize both early-return)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-ext-"));
  setupJobs(cwd, [job({
    id: "R", pid: 999_999, status: "running", endedAt: null, exitCode: null, exitCodeKnown: false,
    finalized: false, finalResult: undefined, taskId: undefined, sessionId: "OTHER",
    cwd: process.cwd(), fpStart: "abc",     // real git workspace; fpEnd can be collected
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

it("B3 shutdown does not kill jobs (cross-restart semantics), but records are complete; the next instance can halt until the process disappears", async () => {
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

    // not an orphan: still tracked by the sidecar's pid + startStamp
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

it("finalizeTerminated writes note=killed for a killed chain", async () => {
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
