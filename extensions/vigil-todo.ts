import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentBeforeSettleEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext,
  ExtensionToolContext, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { autofillJob, type AutofillDeps } from "../src/bind/autofill.js";
import { finalizeAndProject } from "../src/bind/finalize.js";
import { halt, isHalted, reapHaltedLeftovers, resume, type HaltDeps } from "../src/bind/halt.js";
import { catchUpScan, sweepAll, type SweepDeps } from "../src/bind/sweep.js";
import { replayBranch } from "../src/board/replay.js";
import { retentionCandidates } from "../src/board/cleanup.js";
import { selectNext } from "../src/board/selectors.js";
import { createBoardStore } from "../src/board/store.js";
import type { BoardState } from "../src/board/types.js";
import { chainJobs, chainTerminated } from "../src/jobs/chain.js";
import { escalate, requestKill } from "../src/jobs/kill.js";
import { createMonitor, recoverJobs } from "../src/jobs/monitor.js";
import { spawnJob, type SpawnRequest } from "../src/jobs/spawn.js";
import { createJobStore, runDir, type JobStore } from "../src/jobs/store.js";
import type { Job } from "../src/jobs/types.js";
import { createConfigLoader } from "../src/lib/config.js";
import { collectFingerprint } from "../src/lib/fingerprint.js";
import {
  createBgKillTool, createBgListTool, createBgRunTool, createTodoTool, detectToolConflict,
  preflight, type ToolDef, type ToolDeps,
} from "../src/tool/register.js";
import { createOverlayController } from "../src/ui/overlay.js";
import { WIDGET_KEY, renderDoctor, renderPanel, renderTodos } from "../src/ui/panel.js";
import { clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../src/wake/ack.js";
import { WAKE_CUSTOM_TYPE, composeWake } from "../src/wake/compose.js";
import { tryDeliver } from "../src/wake/deliver.js";

const OWN_SOURCE = "pi-kit";
const BOARD_CUSTOM_TYPE = "rpiv-todo-state";

function readConfigFile(): { mtimeMs: number; file?: unknown } {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-kit", "config.json");
  try {
    return { mtimeMs: statSync(path).mtimeMs, file: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { mtimeMs: 0 };
  }
}

export default function vigilTodo(pi: ExtensionAPI): void {
  const boards = createBoardStore();
  const monitor = createMonitor();
  const ackTracker = createAckTracker();

  let activeCtx: ExtensionContext | undefined;
  let toolCtx: ExtensionToolContext | undefined;
  let sid = "";
  let cwd = process.cwd();
  let jobs: JobStore = createJobStore(runDir(cwd));
  let degradedNote: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let mergeTimer: NodeJS.Timeout | undefined;
  let lastModelAdvanced = false;
  let wired = false;
  let collapsed = false;
  let conflict = detectToolConflict(pi.getAllTools(), OWN_SOURCE);
  let wakeSeq = 0;

  const getCfg = createConfigLoader(() => {
    const { mtimeMs, file } = readConfigFile();
    const settings = pi.getSettings() as unknown as Record<string, unknown>;
    return { mtimeMs, sources: { file, settings: settings.vigilTodo, legacy: settings.bgRun } };
  });

  const overlay = createOverlayController({
    hasUI: () => activeCtx?.hasUI ?? false,
    setWidget: (key) => { if (!key) activeCtx?.ui.setWidget(WIDGET_KEY, undefined); },
    render: () => renderPanel(boards.get(sid), jobs, getCfg()),
  });

  const notify = (message: string, level: "info" | "warning" | "error" = "warning"): void => {
    if (activeCtx?.hasUI) activeCtx.ui.notify(message, level);
  };

  const jobFacts = () => ({
    hasRunning: (taskId: number) => jobs.all().some((j) => j.taskId === taskId && j.status === "running"),
    hasBackoff: (taskId: number) => jobs.all().some((j) => j.taskId === taskId && j.retryAt != null),
    startedAt: (ref: string) => jobs.get(ref)?.startedAt,
    exists: (id: string) => jobs.get(id) !== undefined,
  });

  const ruleCtx = () => ({ wipLimit: getCfg().wipLimit, facts: jobFacts(), now: Date.now() });

  const haltDeps = (): HaltDeps => ({
    boards, jobs, now: Date.now(), sessionId: sid, kill: killJob,
    notify: (n) => { if (activeCtx) output(activeCtx, n); },
  });

  const persistBoard = (board: BoardState): void => {
    boards.commit(sid, board);
    pi.appendEntry(BOARD_CUSTOM_TYPE, {
      action: "snapshot", params: {}, tasks: board.tasks, nextId: board.nextId, counters: board.counters,
    });
  };

  const persistCounters = (board: BoardState, counters: BoardState["counters"]): void => {
    persistBoard({ ...board, counters });
  };

  const refreshOverlay = (): void => {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    overlay.update(boards.get(sid));
    if (collapsed) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
    if (overlay.isRegistered()) ctx.ui.setWidget(WIDGET_KEY, renderPanel(boards.get(sid), jobs, getCfg()));
  };

  // ── 作业 ───────────────────────────────────────────────────────────────
  const spawnChain = (req: SpawnRequest): { ok: boolean; error?: string; jobId?: string } => {
    const r = spawnJob(req, runDir(req.cwd), Date.now());
    if (!r.ok) return { ok: false, error: r.error };
    r.job.fpStart = collectFingerprint(req.cwd);
    jobs.put(r.job);
    jobs.save();
    monitor.watch(r.job, onJobExit, r.child);
    refreshTimer();
    return { ok: true, jobId: r.job.id };
  };

  const killJob = (idOrRoot: string, by: "self" | "external"): void => {
    const r = requestKill(jobs, idOrRoot, by, Date.now());
    jobs.save();
    for (const id of r.killed) {
      const job = jobs.get(id);
      if (job) void escalate(job.pid, 5000);
    }
    refreshTimer();
  };

  const runVerify = async (command: string): Promise<{ ok: boolean; exitCode: number | null }> => {
    if (!toolCtx) return { ok: false, exitCode: null };
    const out = await toolCtx.executeTool("bash", { command });
    const structured = out.result?.structuredContent as { exit_code?: unknown } | undefined;
    const exitCode = typeof structured?.exit_code === "number" ? structured.exit_code : null;
    return { ok: exitCode === 0, exitCode };
  };

  const parkIfExhausted = (root: Job, ok: boolean, note: string, now: number): void => {
    if (ok || root.taskId === undefined) return;
    const chains = [...new Set(jobs.all().filter((j) => j.taskId === root.taskId).map((j) => j.rootId))];
    if (!chains.every((r) => chainTerminated(jobs, r))) return;
    const board = boards.get(sid);
    const idx = board.tasks.findIndex((t) => t.id === root.taskId);
    if (idx < 0) return;
    const task = board.tasks[idx];
    if (task.status !== "in_progress") return;
    const tasks = [...board.tasks];
    tasks[idx] = {
      ...task, status: "parked", statusSince: now,
      park: { reason: note, at: now, from: "in_progress" },
    };
    persistBoard({ ...board, tasks });
  };

  const finalizeTerminated = (): void => {
    const now = Date.now();
    for (const root of jobs.all()) {
      if (root.id !== root.rootId || root.sessionId !== sid || root.finalized) continue;
      if (!chainTerminated(jobs, root.id)) continue;
      const list = chainJobs(jobs, root.id);
      const last = [...list].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ?? root;
      const ok = last.exitCodeKnown && last.status === "completed" && last.exitCode === 0;
      const note = ok ? "completed"
        : last.status === "killed" ? "killed"
        : last.exitCodeKnown ? `exit ${last.exitCode}`
        : "退出码未知，需重验";
      finalizeAndProject(root.id, jobs, boards, sid, now, note, ok);
      parkIfExhausted(root, ok, note, now);
    }
  };

  const onJobExit = (job: Job): void => {
    const now = Date.now();
    job.fpEnd = collectFingerprint(job.cwd);
    jobs.put(job);
    jobs.save();
    const deps: AutofillDeps = { boards, jobs, cfg: getCfg(), now, sessionId: sid, respawn: spawnChain, notify };
    autofillJob(job.id, deps);
    finalizeTerminated();
    persistBoard(boards.get(sid));
    runSweep();
    refreshOverlay();
    refreshTimer();
    scheduleDeliver();
  };

  // ── sweep ─────────────────────────────────────────────────────────────
  const deliverCatchUp = (roots: string[]): void => {
    if (!roots.length || !activeCtx || !activeCtx.isIdle()) return;
    const board = boards.get(sid);
    if (board.counters.turnsUsed >= getCfg().maxTurns) return;
    const cfg = getCfg();
    const next = selectNext(board, cfg.wipLimit, !admitNewSpawnNow());
    const wakeId = `wc${Date.now().toString(36)}${wakeSeq++}`;
    markSent(jobs, roots, wakeId, Date.now());
    pi.sendMessage(
      { customType: WAKE_CUSTOM_TYPE, content: composeWake(roots, board, jobs, cfg, next), display: false, details: { wakeId, jobs: roots } },
      { deliverAs: "steer", triggerTurn: true },
    );
  };

  const admitNewSpawnNow = (): boolean => {
    const cfg = getCfg();
    const running = jobs.all().filter((j) => j.status === "running").length;
    const reserved = jobs.all().filter((j) => j.retryAt != null).length;
    return running + reserved < cfg.maxConcurrentJobs;
  };

  const runSweep = (): void => {
    if (!sid) return;
    if (isHalted(boards.get(sid))) { refreshTimer(); return; }   // R20：停机后不推进
    const cfg = getCfg();
    const d: SweepDeps = {
      boards, jobs, cfg, now: Date.now(), sessionId: sid, respawn: spawnChain,
      notify: (n) => notify(n), isIdle: () => activeCtx?.isIdle() ?? false,
    };
    const r = sweepAll(d);
    finalizeTerminated();
    const catchUp = catchUpScan(d);
    if (r.respawned || r.retained || catchUp.length) persistBoard(boards.get(sid));
    deliverCatchUp(catchUp);
    refreshTimer();
  };

  const refreshTimer = (): void => {
    const need = !!activeCtx && jobs.all().some((j) => j.status === "running" || j.retryAt != null);
    if (need && !timer) {
      timer = setInterval(tick, 1000);
      timer.unref?.();
    } else if (!need && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = (): void => {
    if (!activeCtx || !sid) return;
    if (isHalted(boards.get(sid))) {
      refreshOverlay();
      refreshTimer();
      return;
    }
    runSweep();
    jobs.gc(getCfg().completedTtlMs, Date.now());
    jobs.save();
    refreshOverlay();
    refreshTimer();
  };

  const initSession = (ctx: ExtensionContext): void => {
    activeCtx = ctx;
    const nextSid = ctx.sessionManager.getSessionId();
    if (nextSid === sid && ctx.cwd === cwd) return;
    sid = nextSid;
    cwd = ctx.cwd;
    jobs = createJobStore(runDir(cwd));
    const loaded = jobs.load();
    degradedNote = loaded.note;
    if (loaded.degraded) notify(loaded.note ?? "sidecar 降级，已从空开始", "error");
    recoverJobs(jobs, Date.now());
    jobs.save();
    for (const job of jobs.all()) {
      if (job.status === "running") monitor.watch(job, onJobExit);   // 进程仍在：pid 轮询接管
    }
    boards.replace(sid, replayBranch(ctx.sessionManager.getBranch()));
    boards.setForeground(sid);
    if (isHalted(boards.get(sid))) {
      reapHaltedLeftovers(haltDeps());                           // §16.8.5：崩溃后补杀残留
    }
    runSweep();
    refreshOverlay();
    refreshTimer();
  };

  // ── 投递 ──────────────────────────────────────────────────────────────
  const deliverAsync = (): void => {
    if (!activeCtx || !sid) return;
    const cfg = getCfg();
    const board = boards.get(sid);
    const d = tryDeliver({
      board, jobs, cfg, now: Date.now(), trigger: "async",
      modelAdvanced: lastModelAdvanced, capacityFull: !admitNewSpawnNow(),
    });
    if (d.kind !== "deliver") return;
    persistCounters(board, d.counters);
    markSent(jobs, d.roots, d.wakeId, Date.now());
    pi.sendMessage(
      { customType: WAKE_CUSTOM_TYPE, content: d.text, display: false, details: { wakeId: d.wakeId, jobs: d.roots } },
      { deliverAs: "steer", triggerTurn: true },
    );
  };

  const scheduleDeliver = (): void => {
    if (mergeTimer) return;
    mergeTimer = setTimeout(() => {
      mergeTimer = undefined;
      deliverAsync();
    }, getCfg().wakeMergeMs);
    mergeTimer.unref?.();
  };

  const boundaryDeliver = (): AgentBeforeSettleEventResult | undefined => {
    if (!activeCtx || !sid) return undefined;
    if (isHalted(boards.get(sid))) return undefined;             // R20：不续跑
    const cfg = getCfg();
    const board = boards.get(sid);
    const d = tryDeliver({
      board, jobs, cfg, now: Date.now(), trigger: "boundary",
      modelAdvanced: lastModelAdvanced, capacityFull: !admitNewSpawnNow(),
    });
    if (d.kind !== "deliver") return undefined;
    persistCounters(board, d.counters);
    markSent(jobs, d.roots, d.wakeId, Date.now());
    ackTracker.expectBoundary(d.wakeId, d.roots);
    return {
      entries: [{
        type: "custom_message", customType: WAKE_CUSTOM_TYPE,
        content: d.text, display: false, details: { wakeId: d.wakeId, jobs: d.roots },
      }],
      continue: true,
    };
  };

  // ── 工具注册 ──────────────────────────────────────────────────────────
  const toolDeps: ToolDeps = {
    sessionId: () => sid,
    cwd: () => cwd,
    board: () => boards.get(sid),
    commit: (state) => boards.commit(sid, state),
    appendEntry: (type, data) => pi.appendEntry(type, data),
    ruleCtx,
    get jobs() { return jobs; },
    get cfg() { return getCfg(); },
    spawn: spawnChain,
    kill: killJob,
    runVerify,
    now: () => Date.now(),
  };

  const registerToolDef = (def: ToolDef): void => {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      prepareArguments: def.prepareArguments as ((args: unknown) => never) | undefined,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        activeCtx = ctx;
        toolCtx = ctx;
        initSession(ctx);
        try {
          return await def.execute(params as unknown as Record<string, unknown>) as never;
        } finally {
          refreshOverlay();
          refreshTimer();
        }
      },
    } as ToolDefinition);
  };

  const output = (ctx: ExtensionContext, text: string): void => {
    ctx.ui.notify(text, "info");
  };

  const commandHandler = (run: (arg: string, ctx: ExtensionCommandContext) => void) =>
    async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      activeCtx = ctx;
      initSession(ctx);
      run(args.trim(), ctx);
    };

  if (!conflict) {
    for (const def of [createTodoTool(toolDeps), createBgRunTool(toolDeps), createBgListTool(toolDeps), createBgKillTool(toolDeps)]) {
      registerToolDef(def);
    }

    pi.registerCommand("vigil-todo", {
      description: "vigil-todo 面板 / halt / resume / doctor",
      handler: commandHandler((arg, ctx) => {
        if (arg === "halt") {
          halt(haltDeps());
          persistBoard(boards.get(sid));
          refreshTimer();
          refreshOverlay();
          return;
        }
        if (arg === "resume") {
          const ok = resume(haltDeps());
          if (ok) {
            persistBoard(boards.get(sid));
            refreshTimer();
            refreshOverlay();
          }
          return;
        }
        if (arg === "doctor") {
          const board = boards.get(sid);
          const now = Date.now();
          const purgedRoots = jobs.all().filter((j) => j.id === j.rootId && j.purged).length;
          const retentionOverdue = retentionCandidates(board, getCfg().taskRetentionMs, now).length;
          const orphanJobs = jobs.all()
            .filter((j) => j.taskId === undefined || !board.tasks.some((t) => t.id === j.taskId)).length;
          output(ctx, renderDoctor(board, jobs, conflict, degradedNote, { purgedRoots, retentionOverdue, orphanJobs }));
          return;
        }
        output(ctx, renderTodos(boards.get(sid), jobs));
      }),
    });

    pi.registerCommand("todos", {
      description: "列出全部任务（exit code / fp 下钻）",
      handler: commandHandler((_arg, ctx) => output(ctx, renderTodos(boards.get(sid), jobs))),
    });

    pi.registerCommand("bg", {
      description: "列出后台作业；/bg k <id> 中止链",
      handler: commandHandler((arg, ctx) => {
        if (arg.startsWith("k ")) {
          const id = arg.slice(2).trim();
          killJob(id, "external");
          output(ctx, `vigil-todo: 已中止 ${id} 的整条链`);
          return;
        }
        const text = jobs.all()
          .map((j) => `${j.id} [${j.status}] exit ${j.exitCode ?? "?"} ${j.label}  ${j.command}`)
          .join("\n") || "No background jobs";
        output(ctx, text);
      }),
    });

    const collapseKey = getCfg().collapseKey;
    if (collapseKey !== "off") {
      try {
        pi.registerShortcut(collapseKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
          description: "Toggle vigil-todo panel",
          handler: (ctx) => {
            activeCtx = ctx;
            initSession(ctx);
            collapsed = !collapsed;
            refreshOverlay();
          },
        });
      } catch { /* 非法按键配置不致命 */ }
    }
  }

  // ── 事件接线（冲突自检通过后） ────────────────────────────────────────
  const wire = (): void => {
    if (wired) return;
    wired = true;

    pi.on("tool_call", (event, ctx) => {
      initSession(ctx);
      if (event.parentToolCallId) return;
      const r = preflight(
        { toolName: event.toolName, input: event.input, parentToolCallId: event.parentToolCallId },
        boards.get(sid), ruleCtx(),
      );
      if (r?.block) return { block: true, reason: r.reason };
    });

    const onCustomMessage = (message: unknown): void => {
      const m = message as { customType?: string; details?: { wakeId?: unknown } } | undefined;
      if (!m || m.customType !== WAKE_CUSTOM_TYPE) return;
      ackTracker.onMessage(jobs, m.customType, m.details?.wakeId);
    };
    pi.on("message_start", (event) => onCustomMessage(event.message));
    pi.on("message_end", (event) => onCustomMessage(event.message));

    pi.on("agent_start", (_event, ctx) => {
      initSession(ctx);
      ackTracker.onAgentStart(jobs, sid);
      lastModelAdvanced = false;
    });

    pi.on("agent_before_settle", (_event, ctx) => {
      initSession(ctx);
      return boundaryDeliver();
    });

    pi.on("agent_settled", (_event, ctx) => {
      initSession(ctx);
      const board = boards.get(sid);
      const counters = clearRenudgeOnSettled(board.counters);
      if (counters.renudgeBudget !== board.counters.renudgeBudget) persistCounters(board, counters);
    });

    pi.on("input", (event, ctx) => {
      initSession(ctx);
      if (event.source === "extension") return;
      if (event.source !== "interactive" && event.source !== "rpc") return;
      const board = boards.get(sid);
      if (board.counters.turnsUsed === 0) return;
      persistCounters(board, resetOnUserInput(board.counters));
    });

    pi.on("tool_execution_start", (event, ctx) => {
      initSession(ctx);
      if (event.parentToolCallId) return;
      if (event.toolName === "bg_run" || event.toolName === "bg_kill") lastModelAdvanced = true;
      if (event.toolName === "todo") {
        const args = (event.args ?? {}) as Record<string, unknown>;
        if (args.action === "verify"
          || (args.action === "update" && args.status !== undefined)) {
          lastModelAdvanced = true;
        }
      }
    });

    pi.on("tool_execution_end", (_event, ctx) => {
      initSession(ctx);
      refreshOverlay();
      refreshTimer();
    });

    const rebuild = (_event: unknown, ctx: ExtensionContext): void => {
      initSession(ctx);
      boards.replace(sid, replayBranch(ctx.sessionManager.getBranch()));
      runSweep();
      refreshOverlay();
    };
    pi.on("session_compact", rebuild);
    pi.on("session_tree", rebuild);

    pi.on("session_shutdown", (_event, ctx) => {
      if (timer) { clearInterval(timer); timer = undefined; }
      if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
      if (!sid) return;
      boards.evict(sid);
      monitor.clearAll();
      overlay.dispose();
      if (activeCtx === ctx) activeCtx = undefined;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    conflict = detectToolConflict(pi.getAllTools(), OWN_SOURCE);
    activeCtx = ctx;
    if (conflict) {
      notify("vigil-todo: todo 工具由其他扩展提供（旧包未卸载），本扩展不注册事件处理器", "error");
      return;
    }
    initSession(ctx);
    wire();
    refreshOverlay();
  });
}
