# pi-kit · vigil-todo

**北极星：走开也放心。** 夜里排一批活去睡，早上回来：该完成的已完成、该停的停在该停处、进度可信。

`vigil-todo` 把任务计划与后台作业合成一条闭环：作业结束自动回填状态、按证据判定完成、失败退避重试、并把唯一下一步送回模型续跑。它取代 `@juicesharp/rpiv-todo` + `pi-bg-run`。

## 安装

1. **先卸载旧包**（硬前置，见 [docs/migration.md](docs/migration.md)）：
   ```bash
   pi remove @juicesharp/rpiv-todo
   pi remove pi-bg-run
   ```
   同名工具「先注册者胜且静默」；两个包同时在场会出现半生效状态。
2. 把本包加入 `~/.pi/agent/settings.json` 的 `packages`（或项目 `.pi/extensions/` 指向 `extensions/vigil-todo.ts`）。
3. 重启 pi。`/vigil-todo doctor` 应显示 `✓ 未发现问题`。

## 工具

| 工具 | 用途 |
|---|---|
| `todo` | `create` / `update` / `list` / `get` / `delete` / `clear` / `verify` |
| `bg_run` | 起后台作业并绑定 `task_id`（仅唯一 `in_progress` 时可省） |
| `bg_list` | 列出作业状态与退出码 |
| `bg_kill` | 中止整条重试链（收 rootId 或链上任意 id） |

`todo` 的动作枚举只新增 `verify`；其余意图全走 `update` + 字段：

```
开工      todo({action:"update", id, status:"in_progress"})
完成      todo({action:"update", id, status:"completed"})
接受 stale todo({action:"update", id, status:"completed", accept:"stale"})
park      todo({action:"update", id, status:"parked", reason:"…"})
重验      todo({action:"verify", id})
```

## 命令

| 命令 | 作用 |
|---|---|
| `/vigil-todo` | 全量任务列表 |
| `/vigil-todo halt` | 强制中断：停止自主推进、杀本会话作业、受影响任务 parked |
| `/vigil-todo resume` | 解除中断（不重置 turnsUsed） |
| `/vigil-todo doctor` | 冲突 / sidecar 降级 / halted / purged / 超期 / 无作业 in_progress |
| `/todos` | 逐条任务（exit code + fp 下钻） |
| `/bg` | 作业列表；`/bg k <id>` 两步确认中止链；`/bg tail <id>` 看日志尾 |

折叠快捷键默认 `ctrl+shift+t`（`off` 关闭）。

## 配置

优先级：`~/.config/pi-kit/config.json` → `pi.getSettings().vigilTodo` → `pi.getSettings().bgRun`（旧键兼容）→ 默认值。

| 键 | 默认 |
|---|---|
| `wipLimit` | 1（模型串行专注一个 todo） |
| `retries` | 3（总尝试 4） |
| `retryDelaysMs` | `[0, 30000, 120000]` |
| `staleReverify` | 1 |
| `maxTurns` | 50 |
| `maxConcurrentJobs` | 10 |
| `completedTtlMs` | 7 天 |
| `taskRetentionMs` | 0（关闭自动清理） |
| `tailLines` / `maxTailBytes` | 20 / 8192 |
| `maxWidgetLines` | 12 |
| `wakeMergeMs` | 250 |
| `notifyRetryMs` | 10min |

## 开发

```bash
npm install
npm test        # vitest
npm run typecheck
npm run coverage:check   # 行≥95% / 分支≥90% / 函数≥95%
npm run verify           # 交付前三件套一次跑齐（test + typecheck + coverage:check）
```

架构：`src/board` 纯状态机（不 import pi）→ `src/jobs` 进程子系统 → `src/bind` 唯一跨界写入层 → `src/wake` 投递 → `src/ui` 只读面板。作业事实只由 sidecar（`/tmp/bg-run/<hash(cwd)>/jobs.json`）说，任务可见性只由会话快照说。
