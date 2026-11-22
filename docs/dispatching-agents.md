# Dispatching sub-agents: correct shape and boundaries

Scope: wrapping “dispatch a sub-agent + wait for its report” in `bg_run` (for example `herdr agent prompt ...`). Core rule: **write the cross-process call as an idempotent poller, not a one-shot dispatcher.**

## 1. Two-step atomic flow

```
todo({action:"create", subject:"…"})           # 1) create the task; keep it pending
bg_run({task_id:<id>, command:"<dispatch + wait>"}) # 2) start the watcher
```

- **Do not manually call `todo({action:"update", id, status:"in_progress"})` first.**
  `bg_run` explicitly accepts a `pending` task: it validates structure/capacity, spawns, and then, in the same synchronous block, binds the job → changes pending to in_progress → appends a snapshot. If binding fails it kills the job it just spawned (`src/tool/register.ts`, bg_run). Doing the update yourself splits one atomic step into three steps that can each fail independently.
- `task_id` may be omitted only when exactly one in_progress task exists; pass it explicitly when starting a pending task.
- Failure direction: when capacity is full the task stays pending (not parked); follow the error and free a slot with `bg_kill` or retry later.

## 2. Idempotent poller pattern

The watcher's `command` must be safe to re-run — vigil-todo retries the same command when the watcher fails (6 total attempts by default). Recommended shape:

1. **Non-blocking dispatch**: `herdr agent prompt …` (**without `--wait`**), returning immediately.
2. **Poll a persistent report file**: the watcher loops with `sleep` and checks the file, then exits with the report's status.

```sh
# illustrative; use the flags of your installed herdr version
herdr agent prompt build "…"            # non-blocking dispatch, no --wait
while [ ! -f /tmp/…/report.json ]; do sleep 5; done
cat /tmp/…/report.json
```

Because the report file persists, re-running the same command after the watcher is killed only **re-attaches to the existing agent/report**; it does not dispatch again. Conversely, if the command is a one-shot dispatcher with no poller, every re-run dispatches duplicate work.

## 3. Semantic gap: halt kills only the watcher

`/vt halt`, `alt+h`, and `bg_kill` kill the **watcher process**; they **cannot kill the independent agent itself**. Pressing alt+h does not mean the build stopped; the agent may still be running. To stop the agent, use the agent's own control plane (for example `herdr agent …`); do not treat vigil-todo's halt as the sub-agent's brake.

## 4. Residual risk and recovery

- **No transaction across processes**: there is no transactional boundary between the watcher and the agent. If the watcher is killed, the agent still runs to completion, unwatched.
- **Detection**: `/vt doctor` reports “N in_progress tasks with no bound job (e.g. #id)”; `bg_list` shows job terminal states.
- **Recovery**:
  - Re-run the same poller command manually (idempotent; it re-attaches to the report file);
  - Or run `todo({action:"verify", id})` so `task.verify.command` re-collects evidence.
- **No automatic re-attach**: after a watcher is killed, vigil-todo does not automatically re-run the command. Why: the command may be a dispatcher (“dispatch + wait”, such as `herdr agent prompt build …`), and re-running it would duplicate the dispatch. vigil-todo cannot tell an idempotent waiter from a non-idempotent dispatcher. **That is exactly why the poller pattern is required.**

## 5. fp:stale is expected for this kind of job

Sub-agents modify files, so `fpStart` differs from `fpEnd` ⇒ `fp:stale` is normal, not a fault. Set `task.verify.command` (a real test suite) on the task; autofill triggers a reverify and runs that command for real, confirming completion with evidence instead of a fingerprint. Intended changes may also be explicitly waived with `accept:"stale"`.
