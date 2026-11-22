# Eight-aspect quality matrix (spec §16)

Every aspect must leave a trace at three layers: a design clause, implementation code, and test assertions. Every path in this table is a real file in the repo.

**Test-count convention**: numbers in parentheses are **the number of tests related to that aspect** (one test file can serve several aspects, so summing across rows can exceed the total file count). The full file count and total come from a real `npm test` run; coverage comes from `npm run coverage:check`.

| Aspect | Design clauses | Implementation files | Test files (test count) |
|---|---|---|---|
| Performance | §10.2, §16.1 | `src/vigil-todo/lib/config.ts` (mtime cache), `src/vigil-todo/lib/tail.ts` (byte-tail read), `src/vigil-todo/jobs/monitor.ts` (event-first + release-on-terminal + single-timer condition), `src/vigil-todo/jobs/coalesce.ts` (merge writes within a sync batch), `src/vigil-todo/jobs/store.ts` (terminal-record cap), `src/vigil-todo/wake/compose.ts` (incremental build + budgeted log reads), `src/vigil-todo/bind/sweep.ts` (zero idle writes + one-pass reverify set + idle fast path), `src/vigil-todo/bind/finalize.ts` (merge finalize+project saves in one tick), `src/vigil-todo/board/cleanup.ts` (idempotent guard), `extensions/vigil-todo.ts` (per-batch fingerprint cache + one snapshot) | `tests/vigil-todo/perf/budget.test.ts` (3), `tests/vigil-todo/perf/scale.test.ts` (1), `tests/vigil-todo/perf/burst.test.ts` (1), `tests/vigil-todo/perf/soak.test.ts` (3), `tests/vigil-todo/perf/wake.test.ts` (1), `tests/vigil-todo/perf/tick.test.ts` (1), `tests/vigil-todo/perf/reap.test.ts` (1) |
| Resilience | §5.3, §7.1, §16.2 | `src/vigil-todo/bind/finalize.ts` (two-step finalize), `src/vigil-todo/bind/sweep.ts` (catch-up driver/compensation/retention + `boardDirty` + dangling-root reaping), `src/vigil-todo/jobs/store.ts` (atomic write/archive/GC/cap/path validation), `src/vigil-todo/jobs/monitor.ts` (recoverJobs + recovered exits go through onJobExit), `src/vigil-todo/wake/deliver.ts` (root state is authoritative + deliverability-aware timer) | `tests/vigil-todo/bind/finalize.test.ts` (12), `tests/vigil-todo/bind/sweep.test.ts` (30), `tests/vigil-todo/jobs/store.test.ts` (9), `tests/vigil-todo/jobs/monitor.test.ts` (7), `tests/vigil-todo/wake/deliver.test.ts` (A3 2) |
| Configurability | §16.3 | `src/vigil-todo/lib/config.ts` (`DEFAULTS` + `CONFIG_KEYS` with min/max + per-key validation + `haltKey`), `docs/vigil-todo/configuration.md` | `tests/vigil-todo/lib/config.test.ts` (16), `tests/selfcheck/config-consumed.test.ts` (2) |
| Usability | §6.4, §8, §16.4, §20 | `src/vigil-todo/ui/panel.ts` (panel/`/todos`/doctor actionable next steps/status bar), `src/vigil-todo/ui/completions.ts` (subcommands / `clear` scopes / dynamic job-id completion), `src/vigil-todo/wake/compose.ts` (real call shape + elapsed time + truncation marker), `extensions/vigil-todo.ts` (`/vt` alias, `/vt clear` clear-history command, quick hint, halt shortcut, command copy), `docs/vigil-todo/dispatching-agents.md` | `tests/vigil-todo/ui/panel.test.ts` (17), `tests/vigil-todo/ui/completions.test.ts` (7), `tests/vigil-todo/wake/compose.test.ts` (10), `tests/vigil-todo/tool/register.test.ts` (10), `tests/vigil-todo/integration/extension-entry.test.ts` (T1–T3/C1–C4/F123–F132) |
| Extensibility | §14, §16.5, §17.5 | `src/vigil-todo/board/types.ts`, `src/vigil-todo/board/invariants.ts` (`JobFacts`/`RuleContext`), `src/vigil-todo/bind/{autofill,sweep,finalize,halt}.ts`, `src/vigil-todo/wake/deliver.ts`, `src/vigil-todo/tool/register.ts` (`ToolDeps`) | `tests/arch/boundaries.test.ts` (4), `tests/arch/scope.test.ts` (4) |
| Self-verification | §13, §16.6, §18.4 | `src/vigil-todo/ui/panel.ts` (`renderDoctor`), `extensions/vigil-todo.ts` (doctor summary: purged/overdue/orphan/cycle), `docs/vigil-todo/dispatching-agents.md` (dispatch boundary doc) | `tests/selfcheck/spec-coverage.test.ts` (9), `tests/selfcheck/config-consumed.test.ts` (2), `tests/vigil-todo/ui/panel.test.ts` (17) |
| Clearing todos | §16.7, §20 | `src/vigil-todo/board/cleanup.ts` (selective clear / `purged` / retention), `src/vigil-todo/tool/register.ts` (clear wiring), `extensions/vigil-todo.ts` (`/vt clear` reuses plan/apply/markPurged), `src/vigil-todo/bind/sweep.ts` (catch-up filter + retention) | `tests/vigil-todo/board/cleanup.test.ts` (17), `tests/vigil-todo/integration/extension-entry.test.ts` (F123–F130/F132) |
| Forced halt | §16.8 | `src/vigil-todo/bind/halt.ts` (halt/resume/reap), `src/vigil-todo/wake/deliver.ts` (first-line gate), `src/vigil-todo/bind/sweep.ts` (two short-circuits), `extensions/vigil-todo.ts` (command + `haltKey` shortcut + before_settle + timer/init short-circuits) | `tests/vigil-todo/bind/halt.test.ts` (12), `tests/vigil-todo/integration/extension-entry.test.ts` (halt shortcut/process disappears) |
| Dependency-cycle and deadlock visibility | §18 (R21) | `src/vigil-todo/board/graph.ts` (DFS three-color cycle detection), `src/vigil-todo/board/reducer.ts` (create/addBlockedBy wiring), `src/vigil-todo/ui/panel.ts` (doctor cycle and "nothing actionable", panel first-line marker) | `tests/vigil-todo/board/cycle.test.ts` (7) |
| Output sanitization and terminal safety | §6.4, §8 (terminal safety) | `src/vigil-todo/lib/sanitize.ts` (including `sanitizeMultiline`), `src/vigil-todo/ui/panel.ts`, `src/vigil-todo/wake/compose.ts`, `src/vigil-todo/tool/envelope.ts`, `src/vigil-todo/tool/register.ts`, `src/vigil-todo/bind/autofill.ts`, `extensions/vigil-todo.ts` (`/bg` and notify) | `tests/vigil-todo/security/output-sanitize.test.ts` (11), `tests/vigil-todo/integration/extension-entry.test.ts` (command sanitization 1) |
| logPath traversal protection | §10.1 (sidecar safety) | `src/vigil-todo/jobs/store.ts` (`relative` + `realpath` containment), `src/vigil-todo/wake/compose.ts`, `src/vigil-todo/bind/autofill.ts`, `extensions/vigil-todo.ts` (`/bg tail`) | `tests/vigil-todo/jobs/store.test.ts` (2), `tests/vigil-todo/wake/compose.test.ts` (1), `tests/vigil-todo/bind/autofill.test.ts` (1), `tests/vigil-todo/integration/extension-entry.test.ts` (1) |
| Trustworthy progress (allExit0/evidence rollover) | §8.1 | `src/vigil-todo/board/selectors.ts` (job-side `allExit0` / `fpUnknown` / `reverified`, TTL evidence fallback), `src/vigil-todo/ui/panel.ts` (summary line) | `tests/vigil-todo/board/selectors.test.ts` (11), `tests/vigil-todo/ui/panel.test.ts` (1) |
| WIP oversell visibility | §8.1 | `src/vigil-todo/ui/panel.ts` (panel first line + doctor) | `tests/vigil-todo/ui/panel.test.ts` (1) |
| Feature completeness and model guidance | §19.1, §19.2, §19.3 | `src/vigil-todo/tool/guidance.ts` (default per-tool snippets + trigger intents + config overrides), `src/vigil-todo/tool/schema.ts` (a description for every parameter), `src/vigil-todo/tool/envelope.ts` (list includeDeleted/status, get details), `src/vigil-todo/ui/panel.ts` (truncateToWidth / status bar), `extensions/vigil-todo.ts` (re-register tool guidance from config at session_start + C1–C6 command surface) | `tests/vigil-todo/tool/guidance.test.ts` (5), `tests/vigil-todo/tool/envelope.test.ts` (7), `tests/vigil-todo/ui/panel.test.ts` (17), `tests/vigil-todo/integration/extension-entry.test.ts` (guidance/killed note/`/vt`/status bar etc.), `tests/vigil-todo/board/edge-cases.test.ts` (9), `tests/vigil-todo/tool/edge-cases.test.ts` (3) |

## Coverage baseline and gates (§19.5)

- Measurement command: `npm run coverage` (v8 provider; excludes the pure type file `src/vigil-todo/jobs/types.ts`)
- Gate command: `npm run coverage:check`; thresholds **lines ≥95% / branches ≥90% / functions ≥95%**; a miss exits non-zero
- Current baseline (2026-11-23): **lines 99.52% / branches 94.31% / functions 98.83%** (465 tests)
- Before delivery run: `npm test && npm run typecheck && npm run coverage:check`, or `npm run verify`
- Perf stability: `fileParallelism:false` (files run serially so perf does not compete with other tests) + JIT warm-up discards the first two batches + median of five p95 batches; the full suite passed five consecutive runs under four CPU burners
- Gate experiment: normally the full suite passes; temporarily removing many tests lowered coverage (98.92→97.33 lines, 92.13→91.71 branches in that experiment), raising the thresholds produced a non-zero `ERROR: Coverage for ... does not meet ...`, and deleting tool/ui tests makes `coverage:check` fail on both self-checks and thresholds.

## Performance baseline (§10.2, 2026-11-22)

`sweepAll` (the 1s tick path) no longer rewrites the sidecar when nothing changed: `sweepRespawns` uses a dirty flag and calls `save()` only after an actual put/delete; `finalizeAndProject` merges finalize and project into one write; `markPurged` is idempotent and skips already-cleared records; `recoverJobs` returns the number of changes so the caller can decide whether to write. We also removed the O(n²) full-table scan of `staleReverifyOf` per job, replacing it with one scan that builds a root set.

- Measurement command: `npx vitest run tests/vigil-todo/perf/scale.test.ts` (20 JIT warm-up iterations, 50 samples; same workload and method as piper's temporary script)
- The post-fix numbers come from one run of the same pre-fix script; repeated runs vary by ±0.03ms. The test asserts median < 1ms and prints mean/median to prevent a regression to unconditional writes.

| Scale (tasks/jobs) | Before | After | Speedup |
|---|---|---|---|
| 50 / 20 | 23.10 ms | 0.008 ms | ~2900× |
| 200 / 100 | 25.61 ms | 0.034 ms | ~750× |
| 200 / 300 | 24.06 ms | 0.050 ms | ~480× |

Write counts are pinned by regression tests: an idle `sweepAll` writes 0 times (`tests/vigil-todo/bind/sweep.test.ts`); due respawn success/failure, clearing a stuck `pendingReverify`, `finalizeAndProject`, and `markPurged` each write exactly once for a real change (`tests/vigil-todo/bind/sweep.test.ts`, `tests/vigil-todo/bind/finalize.test.ts`, `tests/vigil-todo/board/cleanup.test.ts`).

### Full idle-tick cost (including gc + sweep + render + needsTimer)

The table above compares only `sweepAll`. The whole tick path is measured by `tests/vigil-todo/perf/tick.test.ts` at 50/20, 200/100, 200/300, and 200/2000: it times `jobs.gc`, `sweepAll`, `renderPanel`, and `needsTimer`, prints every component mean, and asserts the median total < 1 ms at 50/20, 200/100, and 200/300 (< 2 ms at the 200/2000 terminal cap).

Representative medians on this machine: **0.056 ms (50/20), 0.138 ms (200/100), 0.176 ms (200/300), 0.297 ms (200/2000)**. Before optimization, **`sweepAll` alone** took 22.8 ms; now even at the 2000-job terminal cap the whole tick stays under 1 ms, i.e. ≤0.1% CPU at a 1s tick interval.

### Memory and handles (real-GC soak, independently re-tested by piper)

| Interval | Heap growth before | After |
|---|---|---|
| Cycle 50 → 350 | +0.67 MB | **+0.10 MB** |
| Cycle 350 → 650 | +0.63 MB | **+0.06 MB** |

The handle count stays at 3 throughout, and heap falls after clearAll. The root cause was `monitor.fired`, a Set that only grew (~2.2KB/cycle); it was replaced by releasing the three per-job tables on terminal, with late duplicates naturally ignored because the registration is gone (F31 semantics unchanged).

## Stability and trigger surface (2026-11-22)

### A. Lost-state fixes
- **A1 park not written to the branch snapshot**: `sweepAll` returns `boardDirty` (set by `parkTask` / `projectFinal` / retention); the extension's `runSweep` now compares board object identity and calls `appendEntry` only when there is an unpersisted change. Disk-level regression: the "A1 … replay reads back parked" test in `tests/vigil-todo/integration/extension-entry.test.ts` replays the branch with `replayBranch` and asserts the sidecar `retryAt` was cleared.
- **A2 recovered exits skipped onJobExit**: `onJobExit` already saved unconditionally after `put`; the real gap was that `recoverJobs` marked vanished running jobs failed without going through the exit path (fpEnd / autofill / finalize all skipped). `initSession` now records the running set before loading, and jobs recovered as failed go through `onJobExit` one by one; when `fpStart` is missing it no longer runs git. The regression test reads `fpEnd` back from the sidecar.
- **A3 clock rollback**: `tryDeliver`'s undelivered decision now treats the sidecar `root.notifyState` as authoritative; the watermark only conservatively filters unknown refs. Regression: with watermark=5000 and evidence at=500 it still delivers; unknown refs are still blocked by the watermark.

### B. Stability data (measured on this machine)
- **B1 unbounded monitor growth**: `emit` deletes the per-job entries in `jobs` / `handlers` / `stops` on terminal, so the ever-growing `fired` Set is gone; late duplicates are ignored because "the record no longer exists", preserving F31. Soak (`tests/vigil-todo/perf/soak.test.ts`, real `--expose-gc`): after 5000 cycles heap growth is **−0.2 ~ −0.5 KiB** (pre-fix ~2.2 KB/cycle), handles **2→2**, timers **0**.
- **B2 burst write amplification**: `src/vigil-todo/jobs/coalesce.ts` merges `save()` calls within one synchronous batch into a single synchronous write (outside a batch, saves stay synchronous); the extension wraps tick / onJobExit / initSession / command handling in `batch()`, queues real child close callbacks, and flushes them together in the `setImmediate` check phase (same event-loop turn, not a timer); it also forces a flush before swapping stores and at shutdown. Ten jobs terminating in one synchronous batch (`tests/vigil-todo/perf/burst.test.ts`):

| Metric | Before (check's measurement) | After |
|---|---|---|
| Duration | 223.7 ms | **76–93 ms** (typically ~78 ms) |
| Sidecar writes | 10 | **1** |
| Board snapshots | 20 commits | **2** (one task-state snapshot covering 10 tasks + one delivery-counter snapshot) |

  The remaining cost is near the durability floor: ~21–22 ms for one fsync + ~50 ms for one git fingerprint (10 jobs sharing a cwd sample it once; `fpCache` only lives inside a synchronous batch). Only exits in the same turn merge; real processes spread across different turns persist once per turn (that is the durability requirement; no timers across turns). Command: `npx vitest run tests/vigil-todo/perf/burst.test.ts`.
- **B3 resources and orphans**: real-process cycle p50 **6.8–7.4 ms**, p95 **8.8–11.8 ms**, max **9.8–25.1 ms** (fork/exec jitter, `tests/vigil-todo/perf/soak.test.ts`). After `halt`, real child processes exit (existing escalate tests); `session_shutdown` **deliberately does not kill jobs** (they continue across restarts; see migration), but the regression test verifies the process is still fully tracked by the sidecar's pid+startStamp and a later instance can `/vt halt` it until it disappears — there is no "untracked" orphan. A spawn that fails during bookkeeping (exception path) is uniformly `abandon`ed by `trackSpawned`: it is removed from the spawn table and its process group is SIGKILLed; a unit test injects a throw to verify, and `killNow` really kills a process group in a separate test.
- **B4 jobs record cap**: one record is about **713 B**; with only the 7-day TTL, 10 concurrency × 1 job/minute ≈ **100,800 records ≈ 69 MB**, amplified on every rewrite. `gc` adds a hard cap of `MAX_JOB_RECORDS = 2000` (≈1.4 MB): it reclaims only complete chains whose "root is finalized + evidenceApplied + acked/self", oldest first; running / retryAt / unprojected / unacked records are always kept (`tests/vigil-todo/jobs/store.test.ts`).

### C. Trigger surface
- **C1** Added `/vt`, sharing the handler with `/vigil-todo`, supporting halt/resume/doctor; the original command is kept.
- **C2** Status bar: `renderStatus` emits `● N jobs` / `⚠ N parked` / `⏸ halted` / `✓ done/total`, and passes `undefined` to clear when empty; refresh hangs off the existing `refreshOverlay`/tick, with no new timer.
- **C3** With no arguments, `/vigil-todo` and `/vt` append one line: `halt stop · resume continue · clear purge · doctor self-check · /todos all · /bg jobs`.
- **C4** Added `haltKey` (default `alt+h`, `off` disables; `/reload` required), wired into `CONFIG_KEYS`, `docs/vigil-todo/configuration.md`, and the config-consumed self-check; the shortcut really halts and writes a snapshot.
- **C5** Default guidance adds trigger intents: when the user says they are going to sleep / running overnight / batch / background, proactively create a todo + `bg_run` and tell them `/vt halt` is the brake.
- **C6** The descriptions of `/vigil-todo`, `/vt`, `/todos`, and `/bg` state the trigger shape and common subcommands.

## R3 fixes (2026-11-22)

- **B1 trustworthy summary**: `completedSummary(state, jobs)` now reads each completed task's bound-chain truth from the job side (`root.finalResult.ok` and the terminal job's `fpVerdict`). Evidence is consulted only when every bound job record was reclaimed by TTL, and then `evidenceRolled` is set. A surviving success `chainFinal` can no longer hide an evicted failure final or a present `lastFailure`.
- **B2 marker-based reverify**: `Evidence.reverified` and `Job.finalResult.reverified` are explicit markers written by finalize (`ok && isReverifyBranch(terminal)`). Counts read the marker; note text such as `reverified · …` is display-only and cannot affect the count.
- **B3 dangling-root reaping**: `reapOrphanRoots` purges (job-side, persisted) roots in this session whose `taskId` is missing or no longer exists in the board, once; it clears `retryAt`/`pendingReverify`. `catchUpScan` also guards against dangling tasks and `needsTimer` requires a live bound task, so a tree rollback/clear cannot leave a permanent 1s timer. Doctor still reports these records via `orphanJobs` with `bg_list` / `bg_kill` as the exit.
- **P1 wake read budget**: `composeWake` reserves the footer, builds chain status/reason blocks first, then spends the remaining 4800-character budget on log tails; once <200 characters remain it stops reading logs. A truncated message ends with `... N chains not fully expanded`. 50 chains × 500-line logs: **12.94 ms / 50 reads → 6.73 ms / 1 read**.

## Boundary guards (§16.5 / §17.5)

`tests/arch/boundaries.test.ts` scans the source and asserts:

1. `src/vigil-todo/board/**` does not import `@earendil-works/*` or `extensions/`;
2. `src/vigil-todo/jobs/**` does not import `bind/`, `wake/`, `ui/`, or `tool/`;
3. `src/vigil-todo/ui/**` does not call `commit` / `put` / `save` / `appendEntry`.

`tests/arch/scope.test.ts` asserts retired mechanisms cannot return: `src/` and `extensions/` contain no defer / adopt / heartbeat / claims / adoptedAway, and the three retired module files really do not exist.

`tests/arch/language.test.ts` asserts `src/`, `extensions/`, and `tests/` contain no CJK characters (U+4E00–U+9FFF); the internal design archive under `docs/vigil-todo/design/{specs,plans}/` is deliberately excluded and remains in Chinese.

## Spec↔test mapping (§16.6)

`tests/selfcheck/spec-coverage.test.ts` parses every F number in spec §13 (≥105), excludes numbers retired by the §17.2 scope contraction, and asserts each one appears in the text of `tests/**`; a miss fails. F102 (document-structure self-check) itself is implemented by asserting top-level headings are unique.
