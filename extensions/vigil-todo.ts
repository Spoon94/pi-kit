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
import { applyCleanup, markPurged, planCleanup, retentionCandidates, type ClearScope } from "../src/board/cleanup.js";
import { selectNext } from "../src/board/selectors.js";
import { createBoardStore } from "../src/board/store.js";
import type { BoardState } from "../src/board/types.js";
import { chainJobs, chainTerminated, terminalJob } from "../src/jobs/chain.js";
import { escalate, killNow, requestKill } from "../src/jobs/kill.js";
import { jobFactsOf } from "../src/jobs/facts.js";
import { createMonitor, recoverJobs, recoveredExit } from "../src/jobs/monitor.js";
import { createSaveCoalescer, withCoalescedSave, type SaveCoalescer } from "../src/jobs/coalesce.js";
import { spawnJob, takeChild, trackSpawned, type SpawnRequest } from "../src/jobs/spawn.js";
import { createJobStore, runDir, type JobStore } from "../src/jobs/store.js";
import type { Job } from "../src/jobs/types.js";
import { createConfigLoader } from "../src/lib/config.js";
import { collectFingerprint } from "../src/lib/fingerprint.js";
import { sanitizeMultiline, sanitizeTerminalText } from "../src/lib/sanitize.js";
import { tailLines } from "../src/lib/tail.js";
import {
  createBgKillTool, createBgListTool, createBgRunTool, createTodoTool, detectToolConflict,
  preflight, type ToolDef, type ToolDeps,
} from "../src/tool/register.js";
import { createGuidanceLoader, DEFAULT_GUIDANCE, type ToolGuidance } from "../src/tool/guidance.js";
import { createOverlayController } from "../src/ui/overlay.js";
import { WIDGET_KEY, STATUS_KEY, renderDoctor, renderPanel, renderStatus, renderTodos } from "../src/ui/panel.js";
import { bgCompletions, panelCompletions, todosCompletions } from "../src/ui/completions.js";
import { clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../src/wake/ack.js";
import { WAKE_CUSTOM_TYPE, composeWake } from "../src/wake/compose.js";
import { needsTimer, recoveryWake, settleSend, tryDeliver } from "../src/wake/deliver.js";

const OWN_SOURCE = "pi-kit";
const BOARD_CUSTOM_TYPE = "rpiv-todo-state";

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-kit", "config.json");
}

function settingsSources(pi: ExtensionAPI): { settings?: unknown; legacy?: unknown } {
  const s = pi.getSettings() as unknown as Record<string, unknown>;
  return { settings: s.vigilTodo, legacy: s.bgRun };
}

function settingsKey(pi: ExtensionAPI): string {
  try { return JSON.stringify(settingsSources(pi)) ?? "null"; } catch { return "unserializable"; }
}

export default function vigilTodo(pi: ExtensionAPI): void {
  const boards = createBoardStore();
  const monitor = createMonitor();
  const ackTracker = createAckTracker();

  let activeCtx: ExtensionContext | undefined;
  let toolCtx: ExtensionToolContext | undefined;
  let sid = "";
  let cwd = process.cwd();
  const initialStore = createJobStore(runDir(cwd));
  let saves: SaveCoalescer = createSaveCoalescer(() => initialStore.save());
  let jobs: JobStore = withCoalescedSave(initialStore, saves);
  /** 换 store 前先同步落盘旧记录，再绑定新的合并器。 */
  const openJobs = (dir: string): void => {
    saves.flush();
    const raw = createJobStore(dir);
    const c = createSaveCoalescer(() => raw.save());
    saves = c;
    jobs = withCoalescedSave(raw, c);
  };
  let degradedNote: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let mergeTimer: NodeJS.Timeout | undefined;
  let lastModelAdvanced = false;
  let pendingKill: string | undefined;
  const recovered = new Set<string>();
  let wired = false;
  let collapsed = false;
  let conflict = false;   // 加载期不得调用 action method；真正的判定在 session_start
  let wakeSeq = 0;

  const configStat = () => {
    let mtimeMs = 0;
    try { mtimeMs = statSync(configPath()).mtimeMs; } catch { /* 缺失视为 0 */ }
    return { mtimeMs, settingsKey: settingsKey(pi) };
  };
  const configRead = () => {
    let file: unknown;
    try { file = JSON.parse(readFileSync(configPath(), "utf8")); } catch { /* 缺失/损坏 */ }
    return { file, ...settingsSources(pi) };
  };
  const getCfg = createConfigLoader({ stat: configStat, read: configRead });
  const getGuidance = createGuidanceLoader({ stat: configStat, read: configRead });

  const overlay = createOverlayController({
    hasUI: () => activeCtx?.hasUI ?? false,
    setWidget: (key) => { if (!key) activeCtx?.ui.setWidget(WIDGET_KEY, undefined); },
  });

  const notify = (message: string, level: "info" | "warning" | "error" = "warning"): void => {
    if (activeCtx?.hasUI) activeCtx.ui.notify(sanitizeMultiline(message), level);
  };

  const jobFacts = () => jobFactsOf(jobs);

  const ruleCtx = () => ({ wipLimit: getCfg().wipLimit, facts: jobFacts(), now: Date.now() });

  const haltDeps = (): HaltDeps => ({
    boards, jobs, now: Date.now(), sessionId: sid, kill: killJob,
    notify: (n) => { if (activeCtx) output(activeCtx, n); },
    maxTurns: getCfg().maxTurns,
  });

  let lastPersisted: BoardState | undefined;

  const persistBoard = (board: BoardState): void => {
    if (boards.get(sid) !== board) boards.commit(sid, board);   // 已是当前态则不重复 commit（B2）
    pi.appendEntry(BOARD_CUSTOM_TYPE, {
      action: "snapshot", params: {}, tasks: board.tasks, nextId: board.nextId, counters: board.counters,
    });
    lastPersisted = boards.get(sid);
  };

  /** board 有未落快照的变化才 append：同一 tick 内每任务至多一次（A1/B2）。 */
  const persistIfChanged = (): void => {
    const cur = boards.get(sid);
    if (cur !== lastPersisted) persistBoard(cur);
  };

  const persistCounters = (board: BoardState, counters: BoardState["counters"]): void => {
    persistBoard({ ...board, counters });
  };

  const refreshOverlay = (): void => {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, renderStatus(boards.get(sid), jobs));   // C2：常驻状态栏
    overlay.update(boards.get(sid));
    if (collapsed) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
    if (overlay.isRegistered()) ctx.ui.setWidget(WIDGET_KEY, renderPanel(boards.get(sid), jobs, getCfg()));
  };

  // ── 作业 ───────────────────────────────────────────────────────────────
  const spawnChain = (req: SpawnRequest): { ok: boolean; error?: string; jobId?: string } => {
    // 起点指纹必须在 spawn 之前采集：进程可能立刻改工作区
    const fpStart = collectFingerprint(req.cwd);
    const r = spawnJob({ ...req, fpStart }, runDir(req.cwd), Date.now());
    if (!r.ok) return { ok: false, error: r.error };
    const tracked = trackSpawned(r.job, enqueueJobExit, {
      put: (j) => jobs.put(j),
      save: () => jobs.save(),
      watch: (j, onExit) => monitor.watch(j, onExit, r.child),      // 异常路径：子进程已 spawn 但登记失败 ⇒ 立即杀掉，绝不留下无主进程（B3）
      abandon: (j) => { takeChild(j.id); killNow(j.pid); },
    });
    if (!tracked.ok) return { ok: false, error: tracked.error };
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
    boards.commit(sid, { ...board, tasks });     // 快照由 onJobExit/runSweep 末尾统一 append
  };

  const finalizeTerminated = (): void => {
    const now = Date.now();
    for (const root of jobs.all()) {
      if (root.id !== root.rootId || root.sessionId !== sid || root.finalized) continue;
      if (!chainTerminated(jobs, root.id)) continue;
      const list = chainJobs(jobs, root.id);
      const last = terminalJob(jobs, root.id) ?? root;
      const ok = last.exitCodeKnown && last.status === "completed" && last.exitCode === 0;
      const note = ok ? "completed"
        : last.status === "killed" ? "killed"
        : last.exitCodeKnown ? `exit ${last.exitCode}`
        : "退出码未知，需重验";
      finalizeAndProject(root.id, jobs, boards, sid, now, note, ok);
      parkIfExhausted(root, ok, note, now);
    }
  };

  /** 同一同步批次的 sidecar 写合并 + 指纹缓存（仅存活于批次内）。 */
  const fpCache = new Map<string, string | undefined>();
  let burstDepth = 0;
  const batch = <T>(fn: () => T): T => {
    burstDepth++;
    saves.begin();
    try {
      return fn();
    } finally {
      try { saves.end(); } finally {
        burstDepth--;
        if (burstDepth === 0) fpCache.clear();
      }
    }
  };
  const fpEndFor = (job: Job): string | undefined => {
    if (job.fpStart === undefined) return undefined;
    if (fpCache.has(job.cwd)) return fpCache.get(job.cwd);
    const fp = collectFingerprint(job.cwd);
    fpCache.set(job.cwd, fp);
    return fp;
  };

  /** 单个退出的内存处理；落盘/快照/投递由外层批次统一收口。 */
  const processJobExit = (job: Job): void => {
    if (job.fpEnd === undefined) job.fpEnd = fpEndFor(job);
    jobs.put(job);
    jobs.save();
    const deps: AutofillDeps = { boards, jobs, cfg: getCfg(), now: Date.now(), sessionId: sid, respawn: spawnChain, notify };
    autofillJob(job.id, deps);
    finalizeTerminated();
    runSweep(false);                         // 退出路径交给 250ms 合并窗口，catch-up 不抢跑
  };

  // 多个 close 回调落在同一事件循环 turn 时，先排队，check 阶段一次批次处理（B2）。
  // 不是定时器：setImmediate 在当前 turn 让出到事件循环等待之前执行。
  const exitQueue: Job[] = [];
  let exitFlush: NodeJS.Immediate | undefined;

  const drainExitQueue = (): number => {
    const queued = exitQueue.splice(0);
    for (const job of queued) processJobExit(job);
    return queued.length;
  };

  const flushExitQueue = (): void => {
    if (exitFlush) { clearImmediate(exitFlush); exitFlush = undefined; }
    if (!exitQueue.length) return;
    batch(() => {
      drainExitQueue();
      persistIfChanged();
      refreshOverlay();
      refreshTimer();
      scheduleDeliver();
    });
  };

  const enqueueJobExit = (job: Job): void => {
    job.fpEnd = fpEndFor(job);               // 指纹在退出回调当下采集
    exitQueue.push(job);
    if (exitFlush) return;
    exitFlush = setImmediate(() => { flushExitQueue(); });
    exitFlush.unref?.();
  };

  // ── sweep ─────────────────────────────────────────────────────────────
  const sendWake = (text: string, wakeId: string, roots: string[]): void => {
    try {
      const maybe = pi.sendMessage(
        { customType: WAKE_CUSTOM_TYPE, content: text, display: false, details: { wakeId, jobs: roots } },
        { deliverAs: "steer", triggerTurn: true },
      );
      settleSend(maybe, () => notify("vigil-todo: 唤醒发送失败，等待 catch-up 补偿", "warning"));
    } catch (e) {
      notify(`vigil-todo: 唤醒发送失败（${String(e)}），等待 catch-up 补偿`, "warning");
    }
  };

  const deliverCatchUp = (roots: string[]): boolean => {
    if (!roots.length || !activeCtx || !activeCtx.isIdle()) return false;
    const board = boards.get(sid);
    if (board.counters.turnsUsed >= getCfg().maxTurns) return false;
    const cfg = getCfg();
    const next = selectNext(board, cfg.wipLimit, !admitNewSpawnNow());
    const wakeId = `wc${Date.now().toString(36)}${wakeSeq++}`;
    const counters = { ...board.counters, turnsUsed: board.counters.turnsUsed + 1, renudgeBudget: 1 };
    persistCounters(board, counters);                       // 补偿与正常 DELIVER 同样计入保险丝
    markSent(jobs, roots, wakeId, Date.now());
    saves.flush();                                          // 先落 sent 再发消息
    sendWake(composeWake(roots, board, jobs, cfg, next), wakeId, roots);
    return true;
  };

  const admitNewSpawnNow = (): boolean => {
    const cfg = getCfg();
    const running = jobs.all().filter((j) => j.status === "running").length;
    const reserved = jobs.all().filter((j) => j.retryAt != null).length;
    return running + reserved < cfg.maxConcurrentJobs;
  };

  const runSweep = (deliver = true): boolean => {
    if (!sid) return false;
    if (isHalted(boards.get(sid))) { refreshTimer(); return false; }   // R20：停机后不推进
    const cfg = getCfg();
    const d: SweepDeps = {
      boards, jobs, cfg, now: Date.now(), sessionId: sid, respawn: spawnChain,
      notify: (n) => notify(n), isIdle: () => activeCtx?.isIdle() ?? false,
    };
    sweepAll(d);
    finalizeTerminated();
    const catchUp = catchUpScan(d);
    persistIfChanged();                                     // A1：park/项目/retention 均在此落快照
    const sent = deliver ? deliverCatchUp(catchUp) : false;
    refreshTimer();
    return sent;
  };

  const refreshTimer = (): void => {
    const need = !!activeCtx && needsTimer(boards.get(sid), jobs, getCfg());
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
    batch(() => {
      const now = Date.now();
      const drained = drainExitQueue();        // 先合并本 turn 已排队的真实退出
      if (drained > 0) scheduleDeliver();
      // 恢复作业的退出探活即使 halted 也要跑（halt 时 kill 失败的残留进程不能被拖到 resume 之后）
      for (const id of [...recovered]) {
        const job = jobs.get(id);
        if (!job || job.status !== "running") { recovered.delete(id); continue; }
        const exited = recoveredExit(job, now);
        if (!exited) continue;
        recovered.delete(id);
        jobs.put(exited);
        jobs.save();
        processJobExit(exited);
      }
      if (isHalted(boards.get(sid))) {
        refreshOverlay();
        refreshTimer();
        return;
      }
      runSweep();
      const removed = jobs.gc(getCfg().completedTtlMs, now);
      if (removed > 0) jobs.save();
      persistIfChanged();
      refreshOverlay();
      refreshTimer();
    });                                        // 整个 tick 的 sidecar 变更合并为一次写（B2）
  };

  const initSession = (ctx: ExtensionContext): void => {
    activeCtx = ctx;
    const nextSid = ctx.sessionManager.getSessionId();
    if (nextSid === sid && ctx.cwd === cwd) return;
    flushExitQueue();                        // 旧会话排队的退出先落盘
    if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
    sid = nextSid;
    cwd = ctx.cwd;
    openJobs(runDir(cwd));
    batch(() => {
      const loaded = jobs.load();
      degradedNote = loaded.note;
      if (loaded.degraded) notify(loaded.note ?? "sidecar 降级，已从空开始", "error");
      const runningOnLoad = jobs.all().filter((j) => j.status === "running").map((j) => j.id);
      const recoveredCount = recoverJobs(jobs, Date.now());
      if (recoveredCount > 0) jobs.save();
      recovered.clear();
      for (const job of jobs.all()) {
        if (job.status === "running") recovered.add(job.id);   // 由单 timer 探活，不另起每作业 3s 轮询
      }
      boards.replace(sid, replayBranch(ctx.sessionManager.getBranch()));
      lastPersisted = boards.get(sid);                          // 分支里已有快照，无需重复 append
      boards.setForeground(sid);
      if (isHalted(boards.get(sid))) {
        reapHaltedLeftovers(haltDeps());                           // §16.8.5：崩溃后补杀残留
      }
      // 恢复时已消失的作业补走退出路径：fpEnd / autofill / finalize 不与正常运行分叉（A2）
      for (const id of runningOnLoad) {
        const job = jobs.get(id);
        if (job?.status === "failed") processJobExit(job);
      }
      runSweep();
    });
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
    saves.flush();
    sendWake(d.text, d.wakeId, d.roots);
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
    saves.flush();
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
    appendEntry: (type, data) => {
      pi.appendEntry(type, data);
      if (type === BOARD_CUSTOM_TYPE) lastPersisted = boards.get(sid);   // 工具已自写快照
    },
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
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      parameters: def.parameters,
      prepareArguments: def.prepareArguments as ((args: unknown) => never) | undefined,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        activeCtx = ctx;
        toolCtx = ctx;
        initSession(ctx);
        try {
          return await def.execute(params as unknown as Record<string, unknown>) as never;
        } finally {
          persistIfChanged();
          refreshOverlay();
          refreshTimer();
          saves.flush();
        }
      },
    } as ToolDefinition);
  };

  let registeredGuidance = "";
  const registerTools = (guidance: ToolGuidance): void => {
    const key = JSON.stringify(guidance);
    if (key === registeredGuidance) return;
    for (const def of [
      createTodoTool(toolDeps, guidance), createBgRunTool(toolDeps, guidance),
      createBgListTool(toolDeps, guidance), createBgKillTool(toolDeps, guidance),
    ]) registerToolDef(def);
    registeredGuidance = key;
  };

  const output = (ctx: ExtensionContext, text: string): void => {
    ctx.ui.notify(sanitizeMultiline(text), "info");
  };

  const commandHandler = (run: (arg: string, ctx: ExtensionCommandContext) => void) =>
    async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      activeCtx = ctx;
      initSession(ctx);
      batch(() => run(args.trim(), ctx));
    };

  if (!conflict) {
    registerTools(DEFAULT_GUIDANCE);

    const panelHint = "halt 停 · resume 继续 · clear 清理 · doctor 自检 · /todos 全量 · /bg 作业";
    const panelHandler = commandHandler((arg, ctx) => {
        if (arg === "halt") {
          halt(haltDeps());
          persistBoard(boards.get(sid));
          refreshTimer();
          refreshOverlay();
          return;
        }
        if (arg === "resume") {
          const ok = resume(haltDeps());
          if (!ok) return;
          persistBoard(boards.get(sid));
          const sent = runSweep();
          if (!sent) {
            const board = boards.get(sid);
            const rec = recoveryWake({
              board, jobs, cfg: getCfg(), now: Date.now(), trigger: "async",
              modelAdvanced: true, capacityFull: !admitNewSpawnNow(),
            });
            if (rec.kind === "deliver") {
              persistCounters(board, rec.counters);
              sendWake(rec.text, rec.wakeId, rec.roots);
            }
          }
          refreshTimer();
          refreshOverlay();
          return;
        }
        if (arg === "doctor") {
          const board = boards.get(sid);
          const now = Date.now();
          const purgedRoots = jobs.all().filter((j) => j.id === j.rootId && j.purged).length;
          const retentionOverdue = retentionCandidates(board, getCfg().taskRetentionMs, now).length;
          const orphanJobs = jobs.all()
            .filter((j) => j.taskId === undefined || !board.tasks.some((t) => t.id === j.taskId)).length;
          output(ctx, renderDoctor(board, jobs, conflict, degradedNote,
            { purgedRoots, retentionOverdue, orphanJobs,
              maxTurns: getCfg().maxTurns, wipLimit: getCfg().wipLimit,
              maxConcurrentJobs: getCfg().maxConcurrentJobs }));
          return;
        }
        if (arg === "clear" || arg.startsWith("clear ")) {
          const tokens = arg.slice(5).trim().split(/\s+/).filter(Boolean);
          const scopeToken = tokens[0];
          const allowed = ["completed", "deleted", "settled"] as const;
          if (scopeToken !== undefined && !(allowed as readonly string[]).includes(scopeToken)) {
            output(ctx, `clear ${scopeToken} 不支持；可用范围：${allowed.join(" / ")}（默认 settled）。`
              + "命令面不提供 all，pending / in_progress / parked 不可清理");
            return;
          }
          const board = boards.get(sid);
          // 命令面只允许三个合法范围且从不传 force ⇒ planCleanup 不会报错
          const plan = planCleanup(board, scopeToken as ClearScope | undefined, undefined, jobFacts());
          const next = applyCleanup(board, plan, Date.now());
          const roots = markPurged(jobs, plan.remove, board.tasks);   // 先 purge 再落快照（与工具层同序）
          persistBoard(next);
          const parts: string[] = [];
          if (plan.remove.length === 0) parts.push("没有可清理的历史任务");
          else parts.push(`已清理 ${plan.remove.length} 个任务`);
          if (plan.skipped.length) {
            parts.push(`跳过 ${plan.skipped.map((i) => `#${i}`).join(" ")}（绑有 running 作业，先 bg_kill 或 /vt halt）`);
          }
          if (roots.length) parts.push(`purged ${roots.length} 条链`);
          output(ctx, parts.join(" · "));
          refreshTimer();
          refreshOverlay();
          return;
        }
        output(ctx, `${renderTodos(boards.get(sid), jobs)}\n${panelHint}`);
    });

    pi.registerCommand("vigil-todo", {
      description: "任务面板与控制：无参数看板 + 快捷提示；halt 立即停止全部后台工作；resume 继续；clear 清理历史（completed/deleted/settled）；doctor 自检。短别名 /vt",
      getArgumentCompletions: panelCompletions,
      handler: panelHandler,
    });

    pi.registerCommand("vt", {
      description: "/vigil-todo 短别名：halt 一键停 · resume 继续 · clear 清历史 · doctor 自检",
      getArgumentCompletions: panelCompletions,          // 与 /vigil-todo 共用同一份定义，避免漂移
      handler: panelHandler,
    });

    pi.registerCommand("todos", {
      description: "列出全部任务（含 exit code / fp 下钻）。清理历史用 /vt clear；看后台作业用 /bg",
      getArgumentCompletions: todosCompletions,
      handler: commandHandler((_arg, ctx) => output(ctx, renderTodos(boards.get(sid), jobs))),
    });

    pi.registerCommand("bg", {
      description: "后台作业列表；/bg k <id> 两步确认后中止整条链；/bg tail <id> 看日志尾；清理任务用 /vt clear",
      getArgumentCompletions: (prefix) => bgCompletions(prefix, jobs),
      handler: commandHandler((arg, ctx) => {
        if (arg.startsWith("k ")) {
          const [id, confirm] = arg.slice(2).trim().split(/\s+/);
          const target = id ? jobs.get(id) : undefined;
          if (!target) { output(ctx, `${id ?? "(missing id)"} not found`); return; }
          if (confirm !== "confirm") {
            pendingKill = id;
            const chain = jobs.all().filter((j) => j.rootId === target.rootId)
              .map((j) => `${j.id} [${j.status}] exit ${j.exitCode ?? "?"} ${j.label}`);
            output(ctx, `将中止链 ${target.rootId}:\n${chain.join("\n")}\n再次输入 /bg k ${id} confirm 确认`);
            return;
          }
          if (pendingKill !== id) {
            output(ctx, `先 /bg k ${id} 查看链信息，再 /bg k ${id} confirm`);
            return;
          }
          pendingKill = undefined;
          killJob(id, "external");
          output(ctx, `vigil-todo: 已中止 ${target.rootId} 的整条链`);
          return;
        }
        if (arg.startsWith("tail ")) {
          const id = arg.slice(5).trim();
          const target = jobs.get(id);
          if (!target) { output(ctx, `${id} not found`); return; }
          if (!jobs.isSafeLogPath(target.logPath)) {
            output(ctx, `sidecar 可疑：${target.id} 的 logPath 不在运行目录，已拒绝读取`);
            return;
          }
          const cfg = getCfg();
          const tail = tailLines(target.logPath, cfg.tailLines, cfg.maxTailBytes);
          output(ctx, tail.length ? tail.map(sanitizeTerminalText).join("\n") : "(no log)");
          return;
        }
        const text = jobs.all()
          .map((j) => `${j.id} [${j.status}] exit ${j.exitCode ?? "?"} ${j.label}  ${j.command}`)
          .join("\n") || "No background jobs";
        output(ctx, text);
      }),
    });
  }

  let collapseRegistered = false;
  const registerCollapseShortcut = (): void => {
    if (collapseRegistered) return;
    const collapseKey = getCfg().collapseKey;
    if (collapseKey === "off") return;
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
      collapseRegistered = true;
    } catch { /* 非法按键配置不致命 */ }
  };

  let haltRegistered = false;
  const registerHaltShortcut = (): void => {
    if (haltRegistered) return;
    const haltKey = getCfg().haltKey;
    if (haltKey === "off") return;
    try {
      pi.registerShortcut(haltKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
        description: "vigil-todo: halt all background work",
        handler: (ctx) => {
          activeCtx = ctx;
          initSession(ctx);
          halt(haltDeps());
          persistBoard(boards.get(sid));
          saves.flush();
          refreshTimer();
          refreshOverlay();
        },
      });
      haltRegistered = true;
    } catch { /* 非法按键配置不致命 */ }
  };

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
      ackTracker.onSettled();                                     // entries 被丢弃时清掉等待，防误 ack
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
      lastPersisted = boards.get(sid);
      runSweep();
      refreshOverlay();
    };
    pi.on("session_compact", rebuild);
    pi.on("session_tree", rebuild);

    pi.on("session_shutdown", (_event, ctx) => {
      flushExitQueue();                      // 关闭前处理完排队退出
      if (timer) { clearInterval(timer); timer = undefined; }
      if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
      saves.flush();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      if (!sid) return;
      boards.evict(sid);
      recovered.clear();
      pendingKill = undefined;
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
    registerTools(getGuidance());           // 配置覆盖的指引（与加载期默认不同才重注册）
    wire();
    registerCollapseShortcut();
    registerHaltShortcut();
    refreshOverlay();
  });
}
