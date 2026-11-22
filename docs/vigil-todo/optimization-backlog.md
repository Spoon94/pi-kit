# vigil-todo optimization backlog

> Living document. Records what is done (with evidence) and what remains open.
> Related spec: [`design/specs/2026-11-21-vigil-todo-design.md`](./design/specs/2026-11-21-vigil-todo-design.md)
> Rule: an item leaves this list only when it is implemented, has automated/fault-injection/measured evidence, docs are in sync, and a real-pi smoke passes.

## 1. Performance — done

- Baselines established: `tests/vigil-todo/perf/{budget,scale,burst,soak,wake,tick}.test.ts`.
- Full idle tick (`gc` + `sweepAll` + `renderPanel` + `needsTimer`) is measured by `tests/vigil-todo/perf/tick.test.ts` at 50/20, 200/100, 200/300, and 200/2000; the test prints every component and asserts the total < 1 ms. Before the fix, `sweepAll` alone cost 22.8 ms from unconditional sidecar writes; now zero-change ticks write nothing.
- Wake composition budgeted: 50 chains 6.86 ms; 200 chains with a 2000-char next subject 5.83 ms / 4736 chars, footer intact, log reads stop at budget (`tests/vigil-todo/perf/wake.test.ts`).
- Real-GC soak: +0.10 MB / +0.06 MB per 300 job cycles; handles flat; `clearAll` recovers.
- No timers when there is nothing to do; no per-job polling; single coalesced sidecar write per changed tick.

Open: none known. Re-measure after any change to the tick path (`npm run verify` includes the perf gate).

## 2. Disaster recovery — done, with residual ideas

Done and tested: sidecar corruption (quarantine + restart empty), crash recovery (`recoverJobs`, `pendingReverify` sweep), idempotent two-step finalize, single-delivery watermark, catch-up with `notifyState`, orphan-root reaping, kill/halt/shutdown timer cleanup, no orphan or zombie processes (real-process tests).

Note: cross-session adoption and O_EXCL claims were **removed by scope decision** (spec §17): single session, resumed, no concurrent sessions. Their tests were deleted, not left failing.

Open (ideas, not defects):
- [ ] Disk-full during `save()` — current behavior throws and keeps `dirty`; worth an explicit test.
- [ ] `kill -9` mid-write — atomic rename covers it; a fault-injection test would prove it.

## 3. Customizability — done

- Full config contract: `CONFIG_KEYS` with type/min/max per key, per-key fallback on invalid values, hot-reload matrix in [`configuration.md`](configuration.md).
- Guard: `tests/selfcheck/config-consumed.test.ts` fails if a declared key has no consumer.
- Guidance (prompt snippet/guidelines) overridable per tool via the same priority chain.

Open: none known.

## 4. Usability — done except hands-on feel

Done: rejection/warning messages always carry an executable next step (tested); panel with summary line, parked reasons, retry/fp markers, width clamp; `/vt` alias; status bar; `haltKey` (`alt+h`, `off` supported); Tab completion incl. dynamic job ids; `/vt clear` limited to terminal history by user decision.

Open:
- [ ] **Real TUI hands-on verification** — panel feel at various terminal widths, `alt+h` responsiveness, Tab dropdown interaction, overnight unattended behavior. This is the user's week-long trial; record findings here.

## 5. Extensibility — done

- Multi-extension layout: `extensions/<name>.ts` + `src/<name>/` + `tests/<name>/` + `docs/<name>/`; guide in [`../adding-an-extension.md`](../adding-an-extension.md).
- Repo guards: module boundaries, retired-mechanism scope, CJK-free source — each proven by a permanent injected-violation test in `tests/arch/`.
- No premature `src/shared/`: extract only when a second real consumer appears.

Open:
- [ ] Validate the layout with an actual second extension (the layout is currently exercised by exactly one member).

## 6. Self-verification — done

- Spec↔test mapping enforced: `tests/selfcheck/spec-coverage.test.ts` parses every F-id from the spec and fails if any lacks a test; verified live by deleting an F-id and watching it fail.
- Coverage gate: lines ≥95 / branches ≥90 / functions ≥95 via `npm run coverage:check`; current 99.51 / 94.29 / 98.83.
- `npm run verify` = test + typecheck + coverage, non-zero on any failure.
- `/vt doctor` reports conflicts, orphans, overdue retention, cycles, WIP oversell, turn limit — each with an executable next step.

Open:
- [ ] Real-session `/compact` interaction (replay is unit-tested; a live compaction run is not).

## 7. Publishing — blocked on auth, by design not yet published

- Package metadata ready: `private` removed, MIT license, repository/homepage/bugs, `publishConfig.access`, `files` excludes the design archive (verified via `npm pack --dry-run`: 53 files / 84.7 kB).
- Blocked: the account uses iPhone passkeys (no TOTP), and the npm website is unreachable (HTTP 403) from this network, so `npm login` cannot complete.
- Candidate path: **trusted publishing** (`npm trust github …` + a release workflow) — needs one authenticated session or website access to set up.

Open:
- [ ] Resolve auth (add a TOTP factor from another network, or configure trusted publishing), then publish 0.1.0 after the trial week.
