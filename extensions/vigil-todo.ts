import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentBeforeSettleEventResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext,
  ExtensionToolContext, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { autofillJob, type AutofillDeps } from "../src/vigil-todo/bind/autofill.js";
import { finalizeAndProject } from "../src/vigil-todo/bind/finalize.js";
import { halt, isHalted, reapHaltedLeftovers, resume, type HaltDeps } from "../src/vigil-todo/bind/halt.js";
import { catchUpScan, sweepAll, type SweepDeps } from "../src/vigil-todo/bind/sweep.js";
import { replayBranch } from "../src/vigil-todo/board/replay.js";
import { applyCleanup, markPurged, planCleanup, retentionCandidates, type ClearScope } from "../src/vigil-todo/board/cleanup.js";
import { selectNext } from "../src/vigil-todo/board/selectors.js";
import { createBoardStore } from "../src/vigil-todo/board/store.js";
import type { BoardState } from "../src/vigil-todo/board/types.js";
import { chainJobs, chainTerminated, terminalJob } from "../src/vigil-todo/jobs/chain.js";
import { escalate, killNow, requestKill } from "../src/vigil-todo/jobs/kill.js";
import { jobFactsOf } from "../src/vigil-todo/jobs/facts.js";
import { createMonitor, recoverJobs, recoveredExit } from "../src/vigil-todo/jobs/monitor.js";
import { createSaveCoalescer, withCoalescedSave, type SaveCoalescer } from "../src/vigil-todo/jobs/coalesce.js";
import { spawnJob, takeChild, trackSpawned, type SpawnRequest } from "../src/vigil-todo/jobs/spawn.js";
import { createJobStore, runDir, type JobStore } from "../src/vigil-todo/jobs/store.js";
import type { Job } from "../src/vigil-todo/jobs/types.js";
import { createConfigLoader } from "../src/vigil-todo/lib/config.js";
import { collectFingerprint } from "../src/vigil-todo/lib/fingerprint.js";
import { sanitizeMultiline, sanitizeTerminalText } from "../src/vigil-todo/lib/sanitize.js";
import { tailLines } from "../src/vigil-todo/lib/tail.js";
import {
  createBgKillTool, createBgListTool, createBgRunTool, createTodoTool, detectToolConflict,
  preflight, type ToolDef, type ToolDeps,
} from "../src/vigil-todo/tool/register.js";
import { createGuidanceLoader, DEFAULT_GUIDANCE, type ToolGuidance } from "../src/vigil-todo/tool/guidance.js";
import { ONBOARDING_SECTION, createOnboardingCache } from "../src/vigil-todo/tool/onboarding.js";
import { createOverlayController } from "../src/vigil-todo/ui/overlay.js";
import { WIDGET_KEY, STATUS_KEY, renderDoctor, renderPanel, renderStatus, renderTodos } from "../src/vigil-todo/ui/panel.js";
import { bgCompletions, panelCompletions, todosCompletions } from "../src/vigil-todo/ui/completions.js";
import { clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../src/vigil-todo/wake/ack.js";
import { WAKE_CUSTOM_TYPE, composeWake } from "../src/vigil-todo/wake/compose.js";
import { needsTimer, recoveryWake, settleSend, tryDeliver } from "../src/vigil-todo/wake/deliver.js";

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
  /** Flush the old record to disk before switching stores, then bind the new coalescer. */
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
  let conflict = false;   // never call action methods at load time; the real check happens in session_start
  let wakeSeq = 0;

  const configStat = () => {
    let mtimeMs = 0;
    try { mtimeMs = statSync(configPath()).mtimeMs; } catch { /* missing counts as 0 */ }
    return { mtimeMs, settingsKey: settingsKey(pi) };
  };
  const configRead = () => {
    let file: unknown;
    try { file = JSON.parse(readFileSync(configPath(), "utf8")); } catch { /* missing/corrupt */ }
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
    if (boards.get(sid) !== board) boards.commit(sid, board);   // skip commit when already current (B2)
    pi.appendEntry(BOARD_CUSTOM_TYPE, {
      action: "snapshot", params: {}, tasks: board.tasks, nextId: board.nextId, counters: board.counters,
    });
    lastPersisted = boards.get(sid);
  };

  /** Append only when the board changed since the last snapshot: at most once per task per tick (A1/B2). */
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
    ctx.ui.setStatus(STATUS_KEY, renderStatus(boards.get(sid), jobs));   // C2: persistent status bar
    overlay.update(boards.get(sid));
    if (collapsed) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
    if (overlay.isRegistered()) ctx.ui.setWidget(WIDGET_KEY, renderPanel(boards.get(sid), jobs, getCfg()));
  };

  // ── Jobs ───────────────────────────────────────────────────────────────
  const spawnChain = (req: SpawnRequest): { ok: boolean; error?: string; jobId?: string } => {
    // Capture the start fingerprint before spawn: the process may modify the workspace immediately
    const fpStart = collectFingerprint(req.cwd);
    const r = spawnJob({ ...req, fpStart }, runDir(req.cwd), Date.now());
    if (!r.ok) return { ok: false, error: r.error };
    const tracked = trackSpawned(r.job, enqueueJobExit, {
      put: (j) => jobs.put(j),
      save: () => jobs.save(),
      watch: (j, onExit) => monitor.watch(j, onExit, r.child),      // failure path: child spawned but registration failed ⇒ kill immediately, never leave an orphan process (B3)
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
    boards.commit(sid, { ...board, tasks });     // snapshot is appended at the end of onJobExit/runSweep
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
        : "exit code unknown; reverify required";
      finalizeAndProject(root.id, jobs, boards, sid, now, note, ok);
      parkIfExhausted(root, ok, note, now);
    }
  };

  /** Coalesce sidecar writes for one sync batch + fingerprint cache (alive only within the batch). */
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

  /** In-memory handling of one exit; persistence/snapshot/delivery are finalized by the outer batch. */
  const processJobExit = (job: Job): void => {
    if (job.fpEnd === undefined) job.fpEnd = fpEndFor(job);
    jobs.put(job);
    jobs.save();
    const deps: AutofillDeps = { boards, jobs, cfg: getCfg(), now: Date.now(), sessionId: sid, respawn: spawnChain, notify };
    autofillJob(job.id, deps);
    finalizeTerminated();
    runSweep(false);                         // the exit path uses the 250ms merge window; catch-up must not run ahead
  };

  // When several close callbacks land in one event-loop turn, queue them and process one batch at the check phase (B2).
  // Not a timer: setImmediate runs in the current turn before yielding to the event-loop wait.
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
    job.fpEnd = fpEndFor(job);               // fingerprint captured at the moment of the exit callback
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
      settleSend(maybe, () => notify("vigil-todo: wake send failed; waiting for catch-up compensation", "warning"));
    } catch (e) {
      notify(`vigil-todo: wake send failed (${String(e)}); waiting for catch-up compensation`, "warning");
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
    persistCounters(board, counters);                       // catch-up counts against the fuse like a normal DELIVER
    markSent(jobs, roots, wakeId, Date.now());
    saves.flush();                                          // persist sent before sending the message
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
    if (isHalted(boards.get(sid))) { refreshTimer(); return false; }   // R20: no progress once halted
    const cfg = getCfg();
    const d: SweepDeps = {
      boards, jobs, cfg, now: Date.now(), sessionId: sid, respawn: spawnChain,
      notify: (n) => notify(n), isIdle: () => activeCtx?.isIdle() ?? false,
    };
    sweepAll(d);
    finalizeTerminated();
    const catchUp = catchUpScan(d);
    persistIfChanged();                                     // A1: park/project/retention snapshots are all written here
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
      const drained = drainExitQueue();        // first merge real exits already queued in this turn
      if (drained > 0) scheduleDeliver();
      // Exit liveness probes for recovered jobs must run even when halted (leftovers from a failed kill during halt must not be deferred past resume)
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
    });                                        // coalesce the whole tick's sidecar changes into one write (B2)
  };

  const initSession = (ctx: ExtensionContext): void => {
    activeCtx = ctx;
    const nextSid = ctx.sessionManager.getSessionId();
    if (nextSid === sid && ctx.cwd === cwd) return;
    flushExitQueue();                        // persist exits queued by the old session first
    if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
    sid = nextSid;
    cwd = ctx.cwd;
    openJobs(runDir(cwd));
    batch(() => {
      const loaded = jobs.load();
      degradedNote = loaded.note;
      if (loaded.degraded) notify(loaded.note ?? "sidecar degraded; starting empty", "error");
      const runningOnLoad = jobs.all().filter((j) => j.status === "running").map((j) => j.id);
      const recoveredCount = recoverJobs(jobs, Date.now());
      if (recoveredCount > 0) jobs.save();
      recovered.clear();
      for (const job of jobs.all()) {
        if (job.status === "running") recovered.add(job.id);   // probed by the single timer; no separate 3s poll per job
      }
      boards.replace(sid, replayBranch(ctx.sessionManager.getBranch()));
      lastPersisted = boards.get(sid);                          // branch already has a snapshot; no duplicate append needed
      boards.setForeground(sid);
      if (isHalted(boards.get(sid))) {
        reapHaltedLeftovers(haltDeps());                           // §16.8.5: kill leftovers after a crash
      }
      // Jobs that disappeared during recovery still take the exit path: fpEnd / autofill / finalize do not diverge from normal operation (A2)
      for (const id of runningOnLoad) {
        const job = jobs.get(id);
        if (job?.status === "failed") processJobExit(job);
      }
      runSweep();
    });
    refreshOverlay();
    refreshTimer();
  };

  // ── Delivery ─────────────────────────────────────────────────────────
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
    if (isHalted(boards.get(sid))) return undefined;             // R20: do not continue
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

  // ── Tool registration ────────────────────────────────────────────────
  const toolDeps: ToolDeps = {
    sessionId: () => sid,
    cwd: () => cwd,
    board: () => boards.get(sid),
    commit: (state) => boards.commit(sid, state),
    appendEntry: (type, data) => {
      pi.appendEntry(type, data);
      if (type === BOARD_CUSTOM_TYPE) lastPersisted = boards.get(sid);   // the tool already wrote its own snapshot
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

    const panelHint = "halt stop · resume continue · clear purge · doctor self-check · /todos all · /bg jobs";
    const panelHandler = commandHandler((arg, ctx) => {
        if (arg === "halt") {
          halt(haltDeps());
          persistBoard(boards.get(sid));
          saves.flush();                       // leave a durable trail before aborting the in-flight turn
          ctx.abort();
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
            output(ctx, `clear ${scopeToken} is not supported; available scopes: ${allowed.join(" / ")} (default settled). `
              + "The command surface does not offer all; pending / in_progress / parked cannot be cleared");
            return;
          }
          const board = boards.get(sid);
          // The command surface allows only the three valid scopes and never passes force ⇒ planCleanup cannot fail
          const plan = planCleanup(board, scopeToken as ClearScope | undefined, undefined, jobFacts());
          const next = applyCleanup(board, plan, Date.now());
          const roots = markPurged(jobs, plan.remove, board.tasks);   // purge first, then persist the snapshot (same order as the tool layer)
          persistBoard(next);
          const parts: string[] = [];
          if (plan.remove.length === 0) parts.push("no history tasks to clear");
          else parts.push(`cleared ${plan.remove.length} tasks`);
          if (plan.skipped.length) {
            parts.push(`skipped ${plan.skipped.map((i) => `#${i}`).join(" ")} (bound to running jobs; bg_kill or /vt halt first)`);
          }
          if (roots.length) parts.push(`purged ${roots.length} chains`);
          output(ctx, parts.join(" · "));
          refreshTimer();
          refreshOverlay();
          return;
        }
        output(ctx, `${renderTodos(boards.get(sid), jobs)}\n${panelHint}`);
    });

    pi.registerCommand("vigil-todo", {
      description: "Task panel and control: no args shows the board + quick hints; halt stops all background work immediately; resume continues; clear purges history (completed/deleted/settled); doctor self-check. Short alias /vt",
      getArgumentCompletions: panelCompletions,
      handler: panelHandler,
    });

    pi.registerCommand("vt", {
      description: "/vigil-todo short alias: halt one-tap stop · resume continue · clear purge history · doctor self-check",
      getArgumentCompletions: panelCompletions,          // shared with /vigil-todo so the definitions cannot drift
      handler: panelHandler,
    });

    pi.registerCommand("todos", {
      description: "List all tasks (with exit code / fp drill-down). Purge history with /vt clear; view background jobs with /bg",
      getArgumentCompletions: todosCompletions,
      handler: commandHandler((_arg, ctx) => output(ctx, renderTodos(boards.get(sid), jobs))),
    });

    pi.registerCommand("bg", {
      description: "List background jobs; /bg k <id> aborts the whole chain after two-step confirmation; /bg tail <id> shows the log tail; clear tasks with /vt clear",
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
            output(ctx, `About to abort chain ${target.rootId}:\n${chain.join("\n")}\nEnter /bg k ${id} confirm again to confirm`);
            return;
          }
          if (pendingKill !== id) {
            output(ctx, `Run /bg k ${id} first to inspect the chain, then /bg k ${id} confirm`);
            return;
          }
          pendingKill = undefined;
          killJob(id, "external");
          output(ctx, `vigil-todo: aborted the whole chain of ${target.rootId}`);
          return;
        }
        if (arg.startsWith("tail ")) {
          const id = arg.slice(5).trim();
          const target = jobs.get(id);
          if (!target) { output(ctx, `${id} not found`); return; }
          if (!jobs.isSafeLogPath(target.logPath)) {
            output(ctx, `suspicious sidecar: logPath of ${target.id} is outside the run directory; read refused`);
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
    } catch { /* an invalid keybinding config is not fatal */ }
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
          ctx.abort();
          refreshTimer();
          refreshOverlay();
        },
      });
      haltRegistered = true;
    } catch { /* an invalid keybinding config is not fatal */ }
  };

  // ── Event wiring (after the conflict check passes) ────────────────────
  const wire = (): void => {
    if (wired) return;
    wired = true;

    const onboardingPrompt = createOnboardingCache();
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

    // §22 onboarding: tell the model when to reach for the board, plus (live mode) a light board digest.
    // pi 1.5.2 exposes systemPromptOptions only here, so the base sentence also covers the first run.
    pi.on("before_agent_start", (event, ctx) => {
      initSession(ctx);
      const mode = getCfg().onboardingPrompt;
      if (mode === "off") return;                     // off adds nothing and leaves other content alone
      const injection = onboardingPrompt(boards.get(sid), getGuidance(), mode);
      const options = event.systemPromptOptions;
      const current = typeof options.appendSystemPrompt === "string" ? options.appendSystemPrompt : "";
      if (injection.append && !current.includes(injection.append)) {
        options.appendSystemPrompt = current ? `${current}\n\n${injection.append}` : injection.append;
      }
      // The digest lives in our own section: assigning it replaces the previous version instead of
      // appending, so a changing board can never stack stale summaries (§22, F139).
      if (injection.board !== undefined) {
        options.sections = { ...(options.sections ?? {}), [ONBOARDING_SECTION]: injection.board };
      } else if (options.sections && ONBOARDING_SECTION in options.sections) {
        const next = { ...options.sections };
        delete next[ONBOARDING_SECTION];
        options.sections = next;
      }
    });

    pi.on("agent_before_settle", (_event, ctx) => {
      initSession(ctx);
      return boundaryDeliver();
    });

    pi.on("agent_settled", (_event, ctx) => {
      initSession(ctx);
      ackTracker.onSettled();                                     // clear pending when entries are dropped to prevent false acks
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
      flushExitQueue();                      // drain queued exits before shutdown
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
      notify("vigil-todo: the todo tool is provided by another extension (old package not uninstalled); this extension registers no event handlers", "error");
      return;
    }
    initSession(ctx);
    registerTools(getGuidance());           // config-overridden guidance (re-register only if it differs from the load-time default)
    wire();
    registerCollapseShortcut();
    registerHaltShortcut();
    refreshOverlay();
  });
}
