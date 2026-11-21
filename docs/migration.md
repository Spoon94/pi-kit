# 从 rpiv-todo + pi-bg-run 迁移到 vigil-todo

## 0. 硬前置：必须卸载两个旧包

```bash
pi remove @juicesharp/rpiv-todo
pi remove pi-bg-run
```

pi 1.5.2 的行为（已从 `dist/` 源码取证，见 [p0-findings.md](p0-findings.md)）：

- **同名工具先注册者胜，后来者被静默丢弃**（`runner.js:410-421`）。两包同时在场时，`todo` 归谁完全取决于 `settings.packages` 的声明顺序。
- **事件是广播的**，两个包都会收到 `tool_call` / `tool_result`。于是可能出现「旧包的 reducer 在写状态、新包的预检在拦截」的半生效状态——比完全不生效更难排查。
- 启动自检：`session_start` 用 `getAllTools()` 查 `todo` 的 `sourceInfo`，不是本扩展就 `notify(..., "error")` 并且**不注册事件处理器**。`/vigil-todo doctor` 第一条也会报冲突。

**只追加本包而不卸载旧包，不算安装成功。**

## 1. 兼容方向：单向

- 本扩展**读得懂旧包的 4 状态快照**（`customType: "rpiv-todo-state"`），并原样呈现。
- 本扩展写**超集**：同样是 `rpiv-todo-state`，新增 `parked`、`evidence`、`lastFailure`、`inProgressSince`、`park`、`defer` 等字段。
- **旧包读不了新快照**：它对快照做整体 `every(isTask)` 校验，遇到不认识的 `parked` 会跳过整份快照。因此**回滚不可行**（见 §4）。

## 2. `inProgressSince` 迁移 fallback

旧快照没有 `inProgressSince`。replay 时：

```
inProgressSince = task.inProgressSince ?? task.statusSince ?? 0
```

`0` 表示「无信息」，R3 新近度判定会跳过它 ⇒ 迁移任务仍可被自动完成，不会只能 park。

## 3. 配置迁移

旧包 `pi-bg-run` 的配置表（`maxConcurrentJobs` / `completedTtlMs` / `widgetRefreshMs` / `killTimeoutMs`）**从来没有生效过**：它读 `ctx.settings?.bgRun`，而 pi 的 extension context 里根本没有 `settings` 字段（恒为 `undefined`）。

新读取链固定为：

```
~/.config/pi-kit/config.json
  → pi.getSettings().vigilTodo
  → pi.getSettings().bgRun        （旧键兼容）
  → 默认值
```

把旧配置从 `settings.json` 的 `bgRun` 键挪到 `vigilTodo`（或直接改配置文件）即可，非法值逐项退回默认。

## 4. 为什么不能回滚

1. 旧包跳过含 `parked` 的整份快照 ⇒ 任务列表直接消失。
2. 新包的 `inProgressSince` / `evidence` / `lastFailure` 旧包不认识，重新按旧包写回会丢证据与失败阻断。
3. sidecar 的链级状态（`finalized` / `pendingReverify`）与旧包的 `jobs.json` 布局不兼容，混用会让 defer 释放与收养判断失真。

如果确实要回退：先 `/todos` 导出任务文本、备份 `~/.pi/agent/sessions/` 与 `/tmp/bg-run/`，再接受「已完成的自动判定丢失、parked 任务需手工重建」的代价。

## 5. 迁移后自检

```
/vigil-todo doctor     # ✓ 未发现问题
/todos                 # 旧任务应原样出现
/bg                    # 旧作业记录可见（sidecar 损坏会留档并从空开始）
```

- 旧包在夜里跑完的作业：若旧会话不再打开，新会话会在心跳判定旧会话不活跃后**收养**这些已终结的孤儿链，把绑定任务导入并投影证据（repair 日志 + notify）。
- running 链不会收养，避免两个会话驱动同一进程；等它终结后由单 timer 归入。
