# pi-kit · vigil-todo：todo + bg 融合设计方案

> **Historical design record.** Superseded by [`docs/superpowers/specs/2026-11-21-vigil-todo-design.md`](../superpowers/specs/2026-11-21-vigil-todo-design.md). Kept for history; see the spec for current behavior.

> 状态：草案 v0.2（未实现）
> 范围：`extensions/vigil-todo.ts` 一个扩展，取代 `@juicesharp/rpiv-todo` + `pi-bg-run`
> 本文只谈设计与取舍，不含实现代码
> P0 假设已验证完毕 → [`p0-findings.md`](./p0-findings.md)（Q1/Q4 推翻了 v0.1 的两处设计，已回写）

---

## 0. 一句话

**把「计划」和「执行」合成一条闭环：任务状态是唯一事实源，后台作业是它的证据来源，作业一结束就自动回填状态并把上下文送回模型续跑。纪律由工具层代码强制，不靠提示词自觉。**

三个承诺：

| 承诺 | 含义 | 可验证标准 |
|---|---|---|
| 计划不会烂尾 | 单 in_progress 上限、依赖未完成不许推进，违反即报错 | 违规调用返回 `isError`，状态不变 |
| 完成是真的 | completed 必须有通过的证据（作业退出码 / 验证命令），失败不可能变 completed | 失败作业后直接 completed 被拒 |
| 结束即续跑 | 作业结束 → 自动回填 → 带结果、日志尾、下一任务唤醒模型 | 空闲时 ≤ 1 个轮询周期内起新轮 |

**非目标**（明确不做，避免膨胀）：任务调度器（自动替你起下一个 bg 作业）、多 agent 编排（那是 `pi-subagents` 的事）、时间/成本统计、跨机器同步、kanban 花活。

---

## 1. 用起来是什么样

### 1.1 典型一轮（模型视角，零新概念）

```
todo({action:"create", tasks:[
  {subject:"实现 parser", verify:{kind:"command", command:"npm test -- parser"}},
  {subject:"跑全量回归", blockedBy:[1], verify:{kind:"command", command:"npm test"}}
]})
todo({action:"update", id:1, status:"in_progress", activeForm:"writing parser"})
bg_run({task_id:1, command:"npm test -- parser", label:"parser tests"})
   → [bg] bg_x1 started · bound to #1
   …（模型这一轮就结束了，人去干别的）
```

作业结束时模型收到（自动回填已完成）：

```
[vigil-todo] job done — parser tests [bg_x1] exit 0 · 12s
task #1 实现 parser — auto-completed ✓ (evidence: bg_x1 exit 0)
log tail (last 20/412 lines):
   ✓ 34 passed (34)
board 1/2 done · #2 跑全量回归 (pending, unblocked)
→ 继续 #2。后台跑：bg_run({task_id:2, ...})
```

模型不需要记得回填、不需要读日志、不需要算下一个是谁。

### 1.2 人类视角

面板（一个 widget，不再是两个抢位置）：

```
● vigil-todo 1/2 · ✶ 1 job
├─ ◐ #1 实现 parser (writing parser) · ✶ 12s bg_x1
└─ ○ #2 跑全量回归 · ⛓ #1 · verify:npm test
```

- 折叠键（默认 `ctrl+shift+t`）→ 一行 `● vigil-todo 1/2 · ✶ 1 job`
- 溢出 → `+2 more (1 completed, 1 pending)`，先丢 completed
- 完成行本轮可见、下一轮自动隐藏，空列表自动卸载
- `/todos` 纯文本全量、`/bg` 作业面板（保留 `k` 两次确认、Enter 看 tail）、`/vigil-todo` 统一入口
- 选项一行提示：`vigil-todo 1/2 · bad: 全量回归?` 不做——状态栏只放数字与作业数，避免噪音

### 1.3 错误信息必须是「下一步该怎么做」

拒绝不是终点，是把模型推回正轨：

```
✗ #2 跑全量回归 is blocked by #1 实现 parser (in_progress)
  → 先完成 #1，或 todo({action:"update", id:2, removeBlockedBy:[1]})
✗ #1 is in_progress; finish or park it first
  → todo({action:"update", id:1, status:"pending"}) 或 (id:2, status:"in_progress", takeover:true)
✗ #1 last evidence failed (bg_x1 exit 1, 12s ago)
  → 修复后 todo({action:"verify", id:1}) 重验；确需跳过：status:"completed", force:true, reason:"…"
```

---

## 2. 概念模型

四个实体，两条事实源，一条铁律。

```
Task ──jobs[]──▶ Job            （绑定边，两侧都存）
  │                │
  └─evidence[]     └─exitCode / signal / logPath
```

| 实体 | 权威存储 | 说明 |
|---|---|---|
| Task | 会话分支 custom entry（`rpiv-todo-state` 快照） | 每会话一份，随分支走 |
| Job | 项目级 sidecar `/tmp/bg-run/<hash>/jobs.json` | 跨会话共享，进程真身在这里 |
| Evidence | 跟随 Task（快照里） | 有界（≤8 条，环形） |
| Binding | 两侧冗余：`task.jobs[]` 与 `job.taskId` | 加载时对账修复 |

**铁律：作业的真实性只由 job 侧说；任务的可见性只由 task 侧说。** 两侧矛盾时以各自为准，绑定边取并集并记一条 `repair` 日志，绝不互相覆盖状态。

### 2.1 字段

```ts
type Status = "pending" | "in_progress" | "completed" | "deleted";

type Task = {
  id: number; subject: string; status: Status;
  description?: string; activeForm?: string; owner?: string;
  blockedBy?: number[]; metadata?: Record<string, unknown>;
  // —— 新增 ——
  verify?: { kind: "command" | "job"; command?: string };
  jobs?: string[];              // 绑定作业，可多个
  evidence?: Evidence[];        // 最近 8 条
  statusSince?: number;         // 进入当前状态的时间（证据新鲜度基准）
  wipSeq?: number;              // 进入 in_progress 的序号（WIP 裁决用）
};

type Evidence = {
  ok: boolean;
  kind: "command" | "job" | "manual";
  at: number;
  exitCode?: number | null;     // null = 未知，永不计入通过
  known?: boolean;              // false → 恢复路径产物
  ref?: string;                 // jobId / toolCallId
  command?: string;
  note?: string;                // 失败首行 / override 理由
};

type Job = {
  id: string; label: string; command: string; logPath: string;
  pid: number; status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null; signal?: string | null;
  startedAt: number; endedAt: number | null;
  // —— 新增 ——
  exitCodeKnown: boolean;       // 关键：区分"真的 0"与"不知道"
  startStamp?: string;          // ps lstart，防 pid 复用误判
  taskId?: number;
  sessionId?: string;           // 谁开的，通知回谁
  reconcile: "pending" | "notified" | "acked";
  kill?: { requestedAt: number; signal: string };
  logBytes?: number;
};
```

**为什么 `exitCodeKnown` 是核心**：`pi-bg-run` 在恢复路径上把「进程没了」直接写成 `completed, exitCode:null`，又在另一条恢复路径上把它写成 `failed`——同一事实两种谎言。我们的规则简单：**不知道就是不知道**，`known:false` 的证据永远不能让任务 completed。

---

## 3. 架构

```
extensions/vigil-todo.ts            注册面：工具 / 命令 / 快捷键 / 事件
  ├── tool/                  参数 schema、响应信封、渲染
  ├── board/                 任务状态机（纯函数 reducer + 不变量）
  │     reducer.ts  invariants.ts  selectors.ts
  ├── jobs/                  进程子系统
  │     spawn.ts  monitor.ts  store.ts（sidecar+GC）  kill.ts
  ├── bind/                  绑定与对账
  │     link.ts  reconcile.ts  autofill.ts
  ├── wake/                  唤醒调度
  │     scheduler.ts  compose.ts  channels.ts
  ├── ui/                    overlay / panel / 状态栏
  └── lib/                   config（缓存）· tail（按字节尾读）· atomic-write · log
```

### 3.1 数据流

```
                    ┌──────────── 事件 ────────────┐
tool todo ──▶ board.reducer ──▶ snapshot ──▶ appendEntry ──▶ overlay.refresh
                    │                                    ▲
                    │ commit-time 校验（R1-R9）           │
bg_run ──▶ jobs.spawn ──▶ monitor(child exit / 轮询) ──▶ autofill
                                                     │      │
                                              evidence ┘      ├─▶ 状态迁移（合法才做）
                                                             └─▶ wake.compose ──▶ sendMessage / before_settle
```

### 3.2 模块纪律

- **`board/` 不许 import pi**，纯 `(state, cmd) → (state, op)`，可单测。
- **`jobs/` 不懂任务**，只暴露 `spawn/kill/get/list/subscribe(onExit)`。
- **`bind/` 是唯一同时懂两边的层**，所有跨界写入走这里，便于加断言与日志。
- **`ui/` 只读快照，不写**。

### 3.3 事件接线

| 事件 | 动作 |
|---|---|
| `session_start` | replay（双读旧 type）→ 校验绑定 → 作业 `recover`（不伪造退出码）→ 补偿唤醒 → 冲突自检 |
| `session_compact` / `session_tree` | replay + 绑定校验 + 刷新（作业不动） |
| `session_shutdown` | 释放本会话槽位；**不杀作业**（保持现状语义），作业保留 `sessionId` 供下次归位 |
| `tool_execution_end` | 本地工具调用后刷新；`autofill` 自身也 `requestRender` |
| `agent_start` | 隐藏上轮 completed；可选注入 20 字以内的当前 WIP 摘要 |
| `agent_before_settle` | 续跑兜底闸（见 §5.3）；**while 循环里反复触发，必须闩锁** |
| `tool_call` | 预检（早失败、好文案）+ 审计 |

---

## 4. 纪律：工具层如何强制

### 4.1 三层防线

| 层 | 手段 | 作用 |
|---|---|---|
| L1 预检 | `tool_call` 事件读快照，明显违规直接 `{block:true, reason}` | 早失败，文案由渲染层展示 |
| L2 提交 | `todo.execute()` 内**同步**读改写（无 await 跨越） | 唯一权威判定；并发批次里第二个调用必然看到第一个的结果 |
| L3 串行（可选） | `executionMode: "sequential"`，配置 `sequentialTodo`，**默认关** | 只买顺序确定性与预检可靠性 |

L1 不能替代 L2：并行工具调用的预检是**先全部跑完**再执行，两个 `update → in_progress` 都会通过预检；只有提交时的读改写能拦下第二个。

**L2 自身即充分**：`execute()` 从读快照到 `appendEntry` 全程同步、无 `await`，JS 单线程 ⇒ 即使并行模式，两个调用的临界区也不会交错。R1 恒成立。

**L3 默认关的原因**（P0 附带发现 A）：`executionMode:"sequential"` 会串行化**整个批次**——批次里只要有一个 `todo`，同批的 `read`/`grep` 也全变串行。代价大于收益，故降级为可选项。

**预检必须跳过嵌套调用**：带 `parentToolCallId` 的调用（如 `verify` 内部跑的 bash）不再预检，否则自己拦自己。

### 4.2 规则表

| # | 规则 | 触发 | 拒绝文案（示例） |
|---|---|---|---|
| R1 | **WIP 上限**（默认 1，可配 2） | `→in_progress` 且已达上限 | `#3 is in_progress; finish or park it first` / `takeover:true` 抢占 |
| R2 | **失败不可 completed** | 最近证据 `ok:false` 且其后无新通过证据 | `#1 last evidence failed (bg_x1 exit 1); verify or force+reason` |
| R3 | **完成需证据**（策略 `bound`/`always`/`off`） | 任务有 job 或 verify 时 completed 缺新鲜通过证据 | `#1 has no passing evidence since it started` |
| R4 | **依赖未完成不许推进** | `→in_progress` / `→completed` 且有未完成 `blockedBy` | `#2 blocked by #1 (in_progress)` |
| R5 | **未知退出码不算证据** | `evidence.known === false` | 不拒绝，但不满足 R3 |
| R6 | **有界 override** | `completed + force + reason` | 放行但写 `evidence{kind:"manual", ok:false, note}`，任务标 `metadata.verification="waived"`，面板 `⚠` |
| R7 | **错误即错误** | 任意拒绝 | `{isError:true, content, details:{error}}`，模型侧不再当成功 |
| R8 | **绑定唯一** | 一个 job 绑两个任务 / 绑已终结 job | `bg_x1 already bound to #7` |
| R9 | **状态变更必落快照** | 任何 state 变化 | `appendEntry` 与内存提交在同一个同步块里完成 |

### 4.3 证据从哪来

| 来源 | 何时 | 可信度 |
|---|---|---|
| `job` 退出码 | 子进程 `exit`/`close` 事件（自进程） | 高（`known:true`） |
| `job` 恢复态 | 重启后进程已消失 | 低（`known:false`，只能阻断、不能通过） |
| `todo verify` | 扩展在 `todo.execute()` 内 `ctx.executeTool("bash", {command})` | 高（走同一套权限与钩子） |
| `tool_result` 补录 | 模型跑的 bash 命令与 `verify.command` 同构且成功 | 中（便利，不作为唯一依据） |
| `manual` | `force + reason` | 留痕，不算通过 |

**默认策略 `bound`**：只有「声明了 verify」或「绑过 job」的任务才被要求证据；纯思考/写作类任务保持零摩擦。`always` 是给强迫症的可选项。

---

## 5. 绑定、回填、续跑

### 5.1 绑定

| 路径 | 说明 |
|---|---|
| 显式 | `bg_run({task_id:2, …})`（推荐，模型一看就懂） |
| 自动 | `bg_run` 未带 `task_id` 且当前恰有 1 个 in_progress 且无运行中作业 → 自动绑 |
| 反向 | `update → in_progress` 时任务已有 `jobs` 且其中 running → 视为已绑定 |
| 解绑 | `update({jobId:null})`；作业终结后自动解除"活跃"语义但保留历史 |

**WIP=1 与并行作业的张力**：限的是*任务*，不是*作业*。一个任务可绑多个作业（`build` + `test` 并行）。这比放宽 WIP 更符合「一个目标、多条验证」。

### 5.2 自动回填（扩展自己改，不经模型）

`onExit` 里按顺序：

```
1. job.status / exitCode / signal 落盘（原子写）
2. 若 job.taskId 存在：
     a. 追加 evidence（exit 0 → ok:true；否则 ok:false，note 取日志末行失败摘要）
     b. 尝试 completed：仅当任务当前 in_progress 且 R1-R5 全过 → 迁移
     c. 迁移失败不报错，只记 note —— 留给唤醒消息告诉模型"为什么没自动完成"
3. 刷新 overlay / 状态栏（合并到下一帧）
4. 交给 wake.scheduler
```

幂等：以 `job.reconcile` 状态机驱动（`pending → notified → acked`），重复 `onExit`、重复启动都不会二次追加证据。

**硬约束（P0 Q5）：回调里不能跑命令。** `ctx.executeTool` 需要“当前模型发起的工具调用”上下文（没有 assistant 消息就直接 `isError`）。所以自动回填**只用作业退出码**作证据，绝不在 `onExit` 里跑验证命令；需要重验时，在唤醒消息里指示模型调 `todo verify`。

人工干预优先：用户/模型已把任务改成 `completed` 或 `pending` 时，回填只记证据不动状态。

### 5.3 续跑：四条通道

| 场景 | 通道 | 保证 |
|---|---|---|
| 模型空闲 | `sendMessage(..., {deliverAs:"steer", triggerTurn:true})` | 立刻新起一轮 |
| 模型正在跑 | 同上 | 当前工具调用结束后送达（pi 的既定语义，不中断执行） |
| 本轮最后一个工具刚结束、即将 settle | `agent_before_settle` 返回 `{entries:[custom_message], continue:true}` | 兜住"最后一个工具就是 bg_run/kill"的空窗 |
| 启动补偿 | `session_start` 对账 `reconcile !== "acked"` 的作业 | 补发一条 catch-up，覆盖"pi 关着时作业跑完" |

#### 两条硬约束（P0 Q4 实测，违反即出 bug）

**① `continue:true` 必须配一条 `custom_message` entry。**
正常一轮以 assistant 文本收尾，此时 `canContinue:false`；只给 `continue:true` 会被丢弃并报 boundary 错误。custom message 在 LLM 投影里是 **user 角色**，追加它才能把 `finalRole` 翻成 `user`、让续跑合法。二者**成对出现，缺一不可**。

**② 闩锁是正确性必需，不是防抖优化。**
`agent_before_settle` 处在一个 `while` 循环里——每次 `agent.continue()` 之后都会**再次触发**。无条件 `continue:true` = **无限唤醒循环**。因此：

```
wakeLatch: 请求续跑时置位 → 只有「新证据到达」或 agent_start 才清除
boundary handler: wakeLatch 已置位 → 直接返回 undefined（不再请求）
```

**防抖**：同一批（250ms 窗口）内完成的多个作业合成一条消息；每作业只唤醒一次；每会话 `maxWakePerSession`（默认 20）上限；**没有下一任务且无失败待处理时，`continue` 置 false**（只报告，不空转）。

**天然安全的部分**：handler 抛异常会被 `emitBoundary` 捕获并 `emitError`，不打断 run。但 `entries` 结构非法会导致整批 `{entries:[], continue:false}` 被丢弃——追加的 entry 必须严格合法。

### 5.4 消息格式（既是通知，也是压缩后的上下文）

```
[vigil-todo] job done — parser tests [bg_x1] exit 0 · 12s
task #1 实现 parser — auto-completed ✓ (evidence: bg_x1 exit 0 @ 12:31:02)
log tail (last 20/412 lines):
<尾部 ≤ 20 行、单行截断到 200 字符>
board 1/2 done · #2 跑全量回归 (pending, unblocked)
→ 继续 #2。后台跑：bg_run({task_id:2, ...})
```

预算：**≤ 1200 token**（含日志尾）。默认 `tailLines: 20`，`maxTailBytes: 8192`；任务多时用 `board 3/12 done · next #4` 一行摘要，不罗列全表。

**下一任务选择**：`pending` ∩ `blockedBy` 全 completed ∩ 未删除，按 `metadata.priority` 降序、`id` 升序取第一个。只给一个，不给候选列表——模型不该再算一遍。

**可选自动化**：`autoPromoteNext`（默认 **关**）。开启后回填成功即把 next 置为 in_progress，消息改为"已自动开始 #4"。默认关是刻意的：自动改状态会与模型自己的判断打架，先观察。

---

## 6. 易用性

### 6.1 模型侧

- 工具面**不增加心智**：仍是 `todo` 一个工具 6 个 action（+ `verify`），`bg_*` 三个。
- 默认零配置：不写 config 就有完整行为。
- 提示词只保留**策略**（何时用、粒度），不再承担**规则**（规则由代码执行，文档化在错误文案里）。
- 每个 action 的参数描述里嵌一句「最常见的下一步」，减少翻文档。
- `todo list` 输出含 `next: #N` 一行，模型无需自己算依赖。

### 6.2 人类侧

- 一个面板，一个折叠键，一个溢出摘要——与现在 rpiv-todo 的观感一致，只是多了作业那一列。
- `/vigil-todo`（总览）/`/todos`（纯文本）/`/bg`（作业面板，含 tail 与 kill）三个入口都保留。
- `/vigil-todo doctor`：一条命令列出「无绑定作业的 in_progress」「evidence 过期」「sidecar 与快照不一致」「孤儿作业」，用于排障。
- 配置分层：`~/.config/pi-kit/config.json`（首选）→ `pi.getSettings().vigilTodo` → `pi.getSettings().bgRun`（旧键兼容）→ 默认值。**绝不读 `ctx.settings`**——P0 Q2 证实该字段不存在。

### 6.3 默认值（都不需要改）

| 项 | 默认 | 理由 |
|---|---|---|
| `wipLimit` | 1 | 这就是要买的纪律 |
| `completionGate` | `bound` | 零摩擦保留，只在有作业/verify 时强制 |
| `tailLines` | 20 | 够看失败摘要，不烧 token |
| `widgetRefreshMs` | 1000（仅运行中且面板可见时） | 人眼够用，空闲不耗电 |
| `killTimeoutMs` | 10000 | 沿用 |
| `maxConcurrentJobs` | 10 | 沿用 |
| `completedTtlMs` | 7 天 | 沿用 |
| `autoPromoteNext` | false | 不抢模型的判断 |

---

## 7. 稳定性

### 7.1 故障模型

| 故障 | 现在（两个旧包） | 设计 |
|---|---|---|
| pi 退出时作业还在跑 | 作业存活，退出码丢失 | 存活不变；恢复时 `exitCodeKnown:false`，**绝不猜** |
| 重启后进程已消失 | 一处记为 completed、一处记为 failed | 统一记 `status:"completed"|"failed"` 但 `known:false`，并作为"待重验"提示 |
| 唤醒发送失败 | `notifiedAt` 已写盘 → 永久漏发 | 先发后记；`reconcile` 状态机 + 启动补偿 |
| sidecar 损坏 | 静默吞掉 → 全部作业消失 | 读失败即把原文件改名 `jobs.json.corrupt-<ts>` 保留现场，从空开始并 notify |
| 写一半崩溃 | `writeFileSync` 非原子 | tmp + `rename`（POSIX 原子），失败重试一次 |
| pid 复用 | 可能把陌生进程当自己的作业 | 落 `startStamp`（`ps -p <pid> -o lstart=`），恢复时比对，不符即判"已结束/未知" |
| 同名工具装了两个包 | **先注册者胜，静默忽略后来者**（P0 Q1） | `session_start` 用 `getAllTools()` 查 `todo` 的 `sourceInfo`；不是自己则 notify **error** 并**不注册自己的事件处理器**（避免半生效） |
| 任务被删但作业在跑 | —— | 自动解绑，作业标 orphan，面板独立显示 |
| `pane`/UI 不可用（headless） | 旧包各自判断 `hasUI` | UI 全部走适配层，headless 下所有刷新变 no-op |

### 7.2 并发与所有权

- 所有状态写入都在事件循环的同步段完成（`spawn` 后立刻 `save`，`onExit` 内一次性算完），避免 `await` 期间被另一个事件插队。
- 作业管理器**按项目**（cwd hash）共享，但通知**按 `sessionId` 定向**：修复旧包「后 attach 的会话抢走别人的通知」问题；owner 不在线时进 catch-up 队列，而不是丢。
- `widget` / `status` 的写入口单一化（`ui.render(snapshot)`），避免多处 `setWidget` 互相覆盖。

### 7.3 资源回收

| 资源 | 回收时机 | 风险控制 |
|---|---|---|
| 日志文件 | 作业结束 + TTL 到期（7 天），`session_start` 时 GC | 只删自己目录下、状态非 running 的 |
| 空项目目录 | GC 时 | 同上 |
| 作业记录 | TTL | running 永不回收 |
| 轮询定时器 | 作业终结即清 | 单 timer 管理全部作业，退出时 `clearAll` |
| 内存中的 evidence | 每任务 8 条环形 | 防止长期会话无界增长 |
| 唤醒队列 | 每会话上限 + acked 即清 | 防止唤醒风暴 |

### 7.4 优雅降级

- replay 失败（快照损坏）→ 空列表 + notify，作业不受影响。
- sidecar 读失败 → 作业列表空 + notify，任务不受影响。
- `agent_before_settle` 抛错 → 捕获后放弃续跑（turn 照常结束），下一次 `sendMessage` 仍能唤醒。
- i18n SDK 缺失 → 英文 fallback；`pi-tui` 缺失 → 纯文本 widget。

---

## 8. 性能

### 8.1 预算

| 指标 | 目标 | 说明 |
|---|---|---|
| 空闲 CPU | **0 定时器** | 无运行作业时不留任何 interval |
| 运行中有作业、面板可见 | 1 个 1s timer | 只为刷新耗时数字；面板不可见/折叠时降到 5s |
| `todo` 工具调用 | p95 < 3ms | 纯内存 O(n)，n≤200 |
| 面板首帧 | < 16ms | 一次 `requestRender`，不重排全表 |
| replay | 1 万条目 < 30ms | 单次线性扫描，只在 3 个生命周期事件触发 |
| 唤醒消息 | ≤ 1200 token | 日志尾按字节截断 |
| 磁盘写 | ≤ 1 次/状态变更，合并 100ms | 原子写，小文件（< 20KB） |

### 8.2 已知热点与对策

| 热点 | 旧包的做法 | 对策 |
|---|---|---|
| 每作业一个 interval，3s 轮询 `kill(pid,0)` | 10 个作业 = 10 个 timer | **事件优先**（`exit`/`close`），仅"恢复来的作业"才轮询，且单 timer 汇总 + 3s→10s 退避 |
| 面板每 500ms 无条件 tick | 空的会话也在跑 | 无运行作业时**停表**；有作业时按 §8.1 |
| 每次 render 读一次 JSON 配置 | `loadConfig()` 每次 `getMaxWidgetLines()` 都读文件 | 配置缓存 + `mtime` 校验，最多 1s 一次 stat |
| 通知里塞完整日志 | 只给路径（省 token 但要多一轮 read） | 按字节从文件尾读 8KB → 取末 N 行，**不读全文件**（训练日志几十 MB） |
| 每次状态变更写整份快照 | O(n) 序列化 | n≤200 时无感；>200 时降级为增量 entry + 定期全量（先不做，留钩子） |
| 唤醒风暴 | 无上限 | 250ms 合并 + 每会话上限 + 无 next 不 continue |

### 8.3 基准用例（进 CI）

1. 200 任务 + 10 作业：`todo list` 1000 次 < 1s；面板 render 1000 次 < 500ms。
2. 1 万条分支历史 replay < 30ms。
3. 100MB 日志尾读 20 行 < 5ms（只读尾部）。
4. 空闲 10 分钟：timer 数 0，CPU 采样 ≈ 0。
5. 10 个作业同时结束：只产生 1 条唤醒消息。

---

## 9. 兼容与迁移

| 项 | 方案 |
|---|---|
| 工具名 | 保留 `todo` / `bg_run` / `bg_list` / `bg_kill`，旧 transcript、权限条目全部可用 |
| 快照格式 | 继续写 `rpiv-todo-state`，字段是超集；旧包的 replay 校验忽略未知键，双向可读 |
| 作业 sidecar | 继续用 `/tmp/bg-run/<hash>/jobs.json`，字段超集；首次启动补 `exitCodeKnown/reconcile/sessionId` |
| 配置 | 先读 `~/.config/pi-kit/config.json`，回落到 `pi.getSettings().bgRun`（旧键）与 `vigil-todo` |
| 卸载顺序 | 停 pi → **必须移除两个旧包**（不是可选）→ 装 `pi-kit` → `/reload` → 跑验收 → `/vigil-todo doctor`。原因：同名工具先注册者胜，追加安装会被静默忽略（P0 Q1） |
| 回滚 | 重装两个旧包即可；新快照旧包能读 |

---

## 10. 验收

### 10.1 功能

| # | 用例 | 期望 |
|---|---|---|
| F1 | 连续两次 `→in_progress` | 第二次 `isError`，状态不变；`takeover` 可抢占 |
| F2 | 同批并行两个 `→in_progress` | 只有一个成功 |
| F3 | 失败作业后直接 completed | 拒绝，原因指向最近的失败证据 |
| F4 | 成功作业后不调用任何工具 | 任务自动 completed，overlay 立刻变 `✓` |
| F5 | 恢复路径（进程消失） | `known:false`，任务**不**自动完成 |
| F6 | 空闲时作业完成 | ≤ 1s 起新轮，消息含日志尾与 `next:` |
| F7 | 最后一个工具是 bg_run 就结束本轮 | `before_settle` 携 `custom_message` entry 续跑一次；**随后不再重复**（闩锁生效，无无限循环） |
| F8 | 关闭 pi 期间作业完成 | 下次启动收到 catch-up 且只一次 |
| F9 | `/compact` 后 `list` | 任务、evidence、绑定全在 |
| F10 | 同 cwd 两个会话各开作业 | 通知各回各家 |
| F11 | 旧会话（旧格式快照）启动 | 任务原样出现，可继续操作 |
| F12 | sidecar 损坏 | 从空开始 + notify + 原文件留档 |
| F13 | 旧包未卸载就装 `pi-kit` | 启动即 error 告警；**不注册事件处理器**，不出现半生效 |
| F14 | 批次里 `todo` + 5 个 `read` | 默认仍并行（`sequentialTodo:false`）；开启后整批串行 |
| F15 | `verify` 内部跑 bash | 不被自己的预检拦住（跳过 `parentToolCallId`） |

### 10.2 故障注入

- 写盘时 `SIGKILL` → 重启后 sidecar 仍可解析（原子写）。
- 手改 jobs.json 的 pid 为 1（复用场景）→ 判为未知，不误判完成。
- 删掉日志文件 → 回填照常，消息里 tail 部位写"(log missing)"。
- 让 `sendMessage` 抛错 → `reconcile` 停在 `pending`，下次启动补发。

---

## 11. 里程碑

| 阶段 | 内容 | 出口 |
|---|---|---|
| P0 ✅ | 假设验证：四个问题已全部从 pi dist 源码取证，见 [`p0-findings.md`](./p0-findings.md) | 完成；Q4/Q1 推翻了原设计两处，已回写本文 |
| P1 | `board/` + `tool/`（R1-R9、`verify`、`isError`、预检跳过嵌套调用） | F1/F2/F3/F9 通过，可替代 rpiv-todo |
| P2 | `jobs/`（事件优先监控、`exitCodeKnown`、原子写、pid 校验、定向通知） | F5/F10/F12 通过 |
| P3 | `bind/` + `wake/`（绑定、回填、四通道、预算、补偿） | F4/F6/F7/F8 通过 |
| P4 | `ui/`（统一面板、列配置、`/vigil-todo doctor`、`/bg` 面板） | 观感对齐 rpiv-todo |
| P5 | 性能基准 + 迁移 + 文档 | §8.3 全部达标 |

---

## 附录 A：从旧包继承的问题（都要在这里被修掉）

| 问题 | 旧包位置 | 本设计的处置 |
|---|---|---|
| 纪律只写在提示词里 | `rpiv-todo`：`todo.ts:58-68`、`docs/tool-schema.md` 明说由 prompt 负责 | §4 全部下沉到 reducer |
| 错误返回不是错误 | `tool/response-envelope.ts:87-101`（无 `isError`） | R7 |
| 恢复态伪造退出码 | `pi-bg-run`：`index.js:142`（completed/null）vs `:355→:329`（failed） | `exitCodeKnown` |
| 先记 `notifiedAt` 再发送 | `index.js:334-336` | `reconcile` 状态机 |
| 配置读 `ctx.settings`（**已证实不存在**） | `index.js:806`；runner.js:621-695 无此字段 | `pi.getSettings()` + 自建 config；旧包那张配置表从未生效 |
| 每作业一个轮询 timer | `index.js:51-80` | 事件优先 + 单 timer |
| 面板 500ms 无条件 tick | `index.js:507` | 无作业停表 |
| 每渲染读配置 | `rpiv-todo` `config.ts:37-42` | 配置缓存 |
| 多会话共享 `pi` 引用，通知串台 | `index.js:759-817` | 按 `sessionId` 定向 |
| 通知不带日志尾，要额外一轮 read | `index.js:421-424` | 尾读 8KB 内联 |

## 附录 B：刻意不做

- 不做「自动起下一个 bg 作业」的调度器（默认 `autoPromoteNext:false` 已是最接近的一步）。
- 不做跨机器/远端执行。
- 不做任务级时间统计与成本。
- 不做多分支并行作业编排（`pi-subagents` 的地盘）。
- 不改模型可见的工具名，不加新命名空间。
