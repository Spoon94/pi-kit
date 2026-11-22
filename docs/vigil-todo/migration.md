# Migrating from rpiv-todo + pi-bg-run to vigil-todo

## 0. Hard prerequisite: uninstall both old packages first

```bash
pi remove @juicesharp/rpiv-todo
pi remove pi-bg-run
```

Behavior of pi 1.5.2, evidenced from `dist/` sources (see [p0-findings.md](p0-findings.md)):

- **pi fails to load the later-registered extension with an explicit tool-conflict error** (`Failed to load extension "...": Tool "todo" conflicts with ...`; observed on pi 1.5.2). The definition layer also falls back to first-registrant-wins, but the loader error already prevents normal coexistence.
- **If both packages somehow load** (only by bypassing the loader error), events are broadcast: both packages receive `tool_call` / `tool_result`, producing a theoretical half-effective state — the old package's reducer writing state while the new package's preflight blocks calls. This is a theoretical risk, not the normal user-visible outcome; the loader error normally stops coexistence first.
- Startup self-check: at `session_start` the extension looks up `todo`'s `sourceInfo` via `getAllTools()`; if it is not ours it notifies an error and **registers no event handlers**. `/vigil-todo doctor` reports the conflict as its first line.

**Appending this package without removing the old ones is not a successful install.**

## 1. Compatibility direction: one-way

- This extension **reads old 4-state snapshots** (`customType: "rpiv-todo-state"`) and renders them as-is.
- It writes a **superset**: same `rpiv-todo-state` type, adding `parked`, `evidence`, `lastFailure`, `inProgressSince`, `park`, and more.
- **The old package cannot read new snapshots**: it validates the whole snapshot with `every(isTask)` and skips the entire snapshot when it meets an unknown `parked`. Therefore **rollback is not viable** (see §4).

## 2. `inProgressSince` migration fallback

Old snapshots have no `inProgressSince`. On replay:

```
inProgressSince = task.inProgressSince ?? task.statusSince ?? 0
```

`0` means "no information"; the R3 freshness check skips it ⇒ migrated tasks can still be auto-completed instead of being forced to park.

## 3. Configuration migration

The old `pi-bg-run` configuration table (`maxConcurrentJobs` / `completedTtlMs` / `widgetRefreshMs` / `killTimeoutMs`) **never took effect**: it read `ctx.settings?.bgRun`, and pi's extension context has no `settings` field at all (always `undefined`).

The new read chain is fixed:

```
~/.config/pi-kit/config.json
  → pi.getSettings().vigilTodo
  → pi.getSettings().bgRun        (legacy key, still honored)
  → defaults
```

Move old values from the `bgRun` key in `settings.json` to `vigilTodo` (or edit the config file directly). Invalid values fall back per-key to defaults.

## 4. Why rollback is not possible

1. The old package skips any snapshot containing `parked` ⇒ the task list disappears entirely.
2. The old package does not understand `inProgressSince` / `evidence` / `lastFailure`; writing back through it loses evidence and failure blocking.
3. Sidecar chain-level state (`finalized` / `pendingReverify`) is incompatible with the old `jobs.json` layout; mixing them corrupts chain-level decisions.

If you must roll back: export task text via `/todos`, back up `~/.pi/agent/sessions/` and `/tmp/bg-run/`, and accept losing automatic completion judgments and rebuilding parked tasks by hand.

## 5. Post-migration self-check

```
/vigil-todo doctor     # expect: ✓ No issues found
/todos                 # old tasks should appear as-is
/bg                    # old job records visible (a corrupt sidecar is archived and restarted empty)
```

- Keep using the same session (resume): task snapshots and the sidecar are both present; model and panel resume directly.
- Jobs that finished while pi was down: after resume, two-step finalize guarantees each chain terminates exactly once, and `notifyState` catch-up delivers exactly once.
- Running jobs left over from last night at resume time: if pid + startStamp still match, monitoring continues; vanished ones are marked `exitCodeKnown:false` and parked — exit codes are never fabricated.
