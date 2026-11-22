# vigil-todo 配置

## 优先级链

```
~/.config/pi-kit/config.json          （最高）
  → pi.getSettings().vigilTodo
  → pi.getSettings().bgRun            （旧键兼容）
  → DEFAULTS                           （最低）
```

逐键独立解析：某个键在最高层出现且合法就用它；非法值（错误类型、低于最小值）**逐项退回默认**，不影响其他键，也不抛异常。文件缺失或损坏等同视为该层没有配置。

## 契约

- **类型与范围**：每个键声明类型与最小值（见下表），`CONFIG_KEYS` 是唯一元数据来源，`default` 直接引用 `DEFAULTS`，文档、校验、默认值不会三处漂移。
- **热更新矩阵**：除 `collapseKey`、`haltKey` 外全部即时生效（每次判定读 mtime 缓存）；两个快捷键涉及注册，需要 `/reload`。
- **失败方向**：配置问题永远不会让扩展崩溃或禁用；最坏情况是某个键回到默认值。

## 全键表

| 键 | 类型 | 最小 | 最大 | 默认 | 生效时机 |
|---|---|---|---|---|---|
| `wipLimit` | int | 1 | 100 | 1 | 即时（每次 WIP 判定） |
| `retries` | int | 0 | 20 | 3 | 即时（下次重试判定；总尝试 = 1 + retries） |
| `retryDelaysMs` | int[] | 0（每项） | 3600000（每项） | `[0, 30000, 120000]` | 即时（下次退避调度） |
| `staleReverify` | int | 0 | 10 | 1 | 即时（下次 stale 判定） |
| `maxTurns` | int | 1 | 10000 | 50 | 即时（`tryDeliver` 第一行闸门） |
| `maxConcurrentJobs` | int | 1 | 200 | 10 | 即时（下次 spawn 准入） |
| `completedTtlMs` | int | 1 | 31536000000（365 天） | 604800000（7 天） | 即时（下次 GC） |
| `taskRetentionMs` | int | 0 | 31536000000（365 天） | **0（关闭）** | 即时（下次 sweep） |
| `tailLines` | int | 1 | 500 | 20 | 即时（下次尾读） |
| `maxTailBytes` | int | 1 | 1048576（1MB） | 8192 | 即时（下次尾读） |
| `maxWidgetLines` | int | 3 | 200 | 12 | 即时（下次渲染） |
| `collapseKey` | string | — | — | `ctrl+shift+t` / `off` | **需 `/reload`**（快捷键只注册一次） |
| `haltKey` | string | — | — | `alt+h` / `off` | **需 `/reload`**（一键强制中断快捷键） |
| `notifyRetryMs` | int | 1 | 86400000（24h） | 600000（10 分钟） | 即时（下次补偿扫描） |
| `wakeMergeMs` | int | 0 | 60000（1min） | 250 | 即时（下次唤醒合并窗口） |

超出最小值或最大值的键**逐项退回默认**，不影响其他键；上限用于防止 `maxTailBytes` 之类配置造成 TB 级缓冲/读盘自伤。

`jobs.json` 另有不可配置的 **2000 条终态记录硬上限**（约 1.4 MB）：sweep 的 GC 在 TTL 之外只回收「已终结 + 已投影 + 已 ack/self」的完整链，running / 退避 / 未投影 / 未 ack 的记录永不因上限被删。

## 工具指引覆盖（§19.2）

配置层（文件 / `settings.vigilTodo` / `settings.bgRun`）可包含：

```json
{
  "guidance": {
    "snippets": {
      "todo": "一句 todo 摘要",
      "bg_run": "一句 bg_run 摘要",
      "bg_list": "一句 bg_list 摘要",
      "bg_kill": "一句 bg_kill 摘要"
    },
    "promptSnippet": "全局兜底摘要（可省略）",
    "promptGuidelines": ["要点 1", "要点 2"]
  }
}
```

`snippets.<tool>` 按工具覆盖（四者应互不相同，Available tools 区逐工具一行）；`promptSnippet` 保持向后兼容，作为未单独覆盖的工具的兜底。优先级与主配置链相同（file > settings.vigilTodo > legacy.bgRun > 默认），全局与 per-tool 均逐项回退。`promptGuidelines` 共享（pi 的 buildRules 会去重，不会 4× 膨胀）。工具在 `session_start` 按生效值注册/重注册：改了 guidance 后**下一次 session_start（或 `/reload`）生效**，不需要重启 pi。默认指引已覆盖 bg_run/bash 选择、WIP=1、park reason、证据完成、clear scope、唤醒后直接推进六条要点。

## `taskRetentionMs` 为什么默认 0

自动删除任务是**不可逆的数据损失**。默认关闭，只有人显式设置一个正整数时才启用；sweep 会清理 `completed` / `deleted` 且 `statusSince` 早于 `now - taskRetentionMs` 的任务，走与手动 `clear` 相同的路径（含 sidecar 的 `purged` 标记）。

**永不自动清理 `parked`**：parked 是等人的决策物，自动删它等于丢掉北极星的交接物。

## 示例

```json
{
  "wipLimit": 1,
  "retries": 2,
  "maxTurns": 30,
  "taskRetentionMs": 604800000,
  "collapseKey": "off",
  "haltKey": "alt+h"
}
```

`collapseKey: "off"` 表示不注册折叠快捷键，`haltKey: "off"` 同理关闭一键中断（两个键都需 `/reload` 生效）。
