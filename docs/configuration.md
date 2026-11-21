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
- **热更新矩阵**：除 `collapseKey` 外全部即时生效（每次判定读 mtime 缓存）；`collapseKey` 涉及快捷键注册，需要 `/reload`。
- **失败方向**：配置问题永远不会让扩展崩溃或禁用；最坏情况是某个键回到默认值。

## 全键表

| 键 | 类型 | 最小 | 默认 | 生效时机 |
|---|---|---|---|---|
| `wipLimit` | int | 1 | 3 | 即时（每次 WIP 判定） |
| `retries` | int | 0 | 3 | 即时（下次重试判定；总尝试 = 1 + retries） |
| `retryDelaysMs` | int[] | 0（每项） | `[0, 30000, 120000]` | 即时（下次退避调度） |
| `staleReverify` | int | 0 | 1 | 即时（下次 stale 判定） |
| `maxTurns` | int | 1 | 50 | 即时（`tryDeliver` 第一行闸门） |
| `maxConcurrentJobs` | int | 1 | 10 | 即时（下次 spawn 准入） |
| `completedTtlMs` | int | 1 | 604800000（7 天） | 即时（下次 GC） |
| `taskRetentionMs` | int | 0 | **0（关闭）** | 即时（下次 sweep） |
| `tailLines` | int | 1 | 20 | 即时（下次尾读） |
| `maxTailBytes` | int | 1 | 8192 | 即时（下次尾读） |
| `maxWidgetLines` | int | 3 | 12 | 即时（下次渲染） |
| `collapseKey` | string | — | `ctrl+shift+t` / `off` | **需 `/reload`**（快捷键只注册一次） |
| `notifyRetryMs` | int | 1 | 600000（10 分钟） | 即时（下次补偿扫描） |
| `heartbeatStaleMs` | int | 1 | 15000（15 秒） | 即时（下次活跃判定） |
| `hungSuspectMs` | int | 1 | 600000（10 分钟） | 即时（下次挂死判定） |
| `wakeMergeMs` | int | 0 | 250 | 即时（下次唤醒合并窗口） |
| `adoptRecheckMs` | int | 1 | 20000（20 秒） | 即时（下次 session_start 复查） |

## `taskRetentionMs` 为什么默认 0

自动删除任务是**不可逆的数据损失**。默认关闭，只有人显式设置一个正整数时才启用；sweep 会清理 `completed` / `deleted` 且 `statusSince` 早于 `now - taskRetentionMs` 的任务，走与手动 `clear` 相同的路径（含 sidecar 的 `purged` 标记）。

**永不自动清理 `parked`**：parked 是等人的决策物，自动删它等于丢掉北极星的交接物。

## 示例

```json
{
  "wipLimit": 2,
  "retries": 2,
  "maxTurns": 30,
  "taskRetentionMs": 604800000,
  "collapseKey": "off"
}
```

`collapseKey: "off"` 表示不注册折叠快捷键（该键仍需 `/reload` 生效）。
