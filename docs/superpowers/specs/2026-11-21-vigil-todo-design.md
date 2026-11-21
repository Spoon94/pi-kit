# vigil-todo 设计规格 v12（check 已 APPROVE）

> 命名：**vigil-todo**
> 日期：2026-11-21
> 状态：✅ **check 评审通过（第十二轮）**，允许按 §15 进入实现阶段
> 最终结论原文："判定：通过。允许进入实现阶段，按 §15 顺序从 P1 开始。"
> 累计十二轮、72 条修订（15+12+6+6+5+5+4+5+4+3+3+3）
> 待办：**用户尚未批准本 spec**（脑暴流程的用户评审门禁）；用户批准后才可写实现计划
> 取代：`@juicesharp/rpiv-todo` + `pi-bg-run`；载体 `pi-kit` 的 `extensions/vigil-todo.ts`
> 前置取证：[`../../p0-findings.md`](../../p0-findings.md)
> 前身：[`../../design.md`](../../design.md) v0.2（功能清单已废，性能/故障模型仍有效）

---

## 0. 修订对照

### 0.1 第一轮（15 条，v2 已修）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| 1 | BLOCKER | `agent_start` 清闩 ⇒ `continue()` 必发它 ⇒ 无限循环 | §7.4 episode 配额（v3 再改为 watermark） |
| 2 | BLOCKER | R4 只认 completed ⇒ 删掉已完成依赖后下游锁死 | §6.2 R4 认 `completed\|deleted` |
| 3 | BLOCKER | defer 解除无驱动者；untilRoot 消失后永久拒 | §4.5 sweep + 孤儿释放 + `defer:null` |
| 4 | MAJOR | re-nudge 与闩锁互斥 | §7.4 配额两格；§7.6 必带新 entry |
| 5 | MAJOR | respawn 撞并发上限 ⇒ 链永不终结 | §7.2 预留槽（v3 再改派生值 + capacity 分流） |
| 6 | MAJOR | 退避窗口无实体可 kill，park 不取消链 | §7.2 `bg_kill` 收 rootId；park 同步取消链 |
| 7 | MAJOR | evidence 环形溢出 ⇒ 失败证据被挤掉 | §5 sticky `lastFailure` |
| 8 | MAJOR | 指纹两条绕过 + 并发噪声 | §5.2 三态（v3 再收窄） |
| 9 | MAJOR | next 不看 WIP 余量；bg_run 是否推进未定义 | §7.3 / §7.8 |
| 10 | MAJOR | 工具面两套写法 | §6.5 统一（v3 再把示例文案清零） |
| 11 | MAJOR | park/defer 共存踩出不可达 | §4.4 互斥；§4.1 转移表 |
| 12 | MAJOR | `at >= statusSince` 作废已通过证据 | §6.2 R3 改 `inProgressSince`（v3 再修 verify 分支与迁移态） |
| 13 | MAJOR | `acked` 无迁移规则；去重字段混用 | §5.3 拆字段（v3 再改 ack 信号） |
| 14 | MINOR | 删除出口只有 completed | §4.1 pending/parked 无产出者可删 |
| 15 | MINOR | F 覆盖缺口；丢了消息合并 | §13 F26-F42（后续轮次扩至 F66）；§7.4 250ms 合并 |

### 0.2 第二轮（12 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R2-1 | BLOCKER | `maxTurns` 从未接入 boundary 闸门，"兜底"是无机制断言 | §7.7 单一 `turnsUsed` 计数器 + boundary 首行闸门 |
| R2-2 | MAJOR | 充值不区分证据来源 ⇒ verify 自持环；`episodeStartedAt` 推进时机未定义 | §7.4 改 `wakeWatermark`，只认异步证据 |
| R2-3 | MAJOR | 重启后 `retryAt` 无 owner ⇒ 链永不终结 ⇒ defer 永不释放 | §7.2 respawn 调度者 + 派生 reservedSlots；§10.2 timer 条件 |
| R2-4 | MAJOR | 容量拒绝与 spawn 失败混同 ⇒ 误 park；先推进后 spawn 无回滚 | §7.1 拆 capacity/spawn_error；§7.8 spawn 成功后再提交 |
| R2-5 | MAJOR | killed 回调覆盖人工 park.reason；killed 写 lastFailure 致永久阻断 | §7.1 人工优先扩围；killed 不写 lastFailure |
| R2-6 | MAJOR | R3 verify 分支同义反复 ⇒ 旧 verify 可完成 | §6.2 R3 verify 也要 `at >= inProgressSince` |
| R2-7 | MAJOR | 迁移任务 `inProgressSince` 为空 ⇒ 恒 false ⇒ 只能 park | §11 replay fallback `?? statusSince ?? 0` |
| R2-8 | MAJOR | 改 `verify.command` 再 verify = 失败洗白口 | §6.6 改动留痕 + 禁用该任务自动完成 |
| R2-9 | MAJOR | 让位无前置 ⇒ 作业在跑却释放 WIP ⇒ 腾挪到 10 并发 | §4.1 让位要求无 running 且无退避链 |
| R2-10 | MAJOR | ack 用 `agent_start` 在 busy 路径永不置位（已核实 `agent-loop.js:121-123`） | §5.3 改用 `message_start/end` + `wakeId` 匹配 |
| R2-11 | MAJOR | 指纹收窄不足 ⇒ 目标场景近乎 100% unknown ⇒ 等于关掉指纹 | §5.2 排除同 task 并行与无写入作业；裁决点移到"是否叫醒人" |
| R2-12 | MINOR | 示例仍是裸函数名；F 范围写错 | §6.4/§6.5/§7.5 全部改真实调用形态；F 范围更正 |

### 0.3 第三轮（6 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R3-1 | BLOCKER | 充值在证据到达时、投递不扣 ⇒ 同一证据被推 3 遍（steer + 2 次 boundary），50 轮在 ~17 次唤醒就熔断 | §7.4 **watermark 只在投递时推进**；删除 wakeQuota，改 `renudgeBudget` |
| R3-2 | BLOCKER | 预留槽自锁：reserved 含链自己 ⇒ max 条链同时退避时全部 respawn 判容量不足 → 5min 后全 parked，重试一次未跑 | §7.2 respawn **先摘自己的 retryAt** 再判；删 `capacityWaitSince` / `retryCapacityWaitMs`（死代码） |
| R3-3 | MAJOR | boundary 通道永远 ack 不了（entry 经 `_refreshFinalizedContext` 入 messages 后 continue，只发 agent_start/turn_start） | §5.3 boundary 提交 entry 并返回 continue 时**直接置 acked** |
| R3-4 | MAJOR | R14 被 defer 绕过，且 §6.4 文案主动教这条路 | §4.3 defer 同样要求自身无 running/退避链；文案改正 |
| R3-5 | MAJOR | 收窄②不可实现（干扰者可能还在跑，无 fpEnd）+ stale 语义反转（自己写文件的任务被冻结） | §5.2 **fpVerdict 延迟到回填时算**；**反提案：stale 自动重验一次**而非 `expectChanges` 豁免（见 §5.2.1） |
| R3-6 | MAJOR | 归零信号漏 busy 路径（`before_agent_start{user}` 只在 `_prepareRun`）⇒ 边看边纠偏的 session 永不归零 | §7.7 改用 **`input` 事件**（source ∈ {interactive, rpc}），已核实 `types.d.ts:928-940` |

另采纳三条附带意见：§7.8 步骤 3 抛错即 kill 已 spawn 子进程；§6.7 update 只读字段集合；§4.1 进入 in_progress 必刷新 `inProgressSince`。

### 0.4 第四轮（6 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R4-1 | BLOCKER | stale 重验无界：per-job 标记 + 重验分支的 retry 不带标记 ⇒ 可无限自我复制；retries/turnsUsed 都管不住 | §5.2.1 上限落到 **rootId 链**（派生计数）+ **重验分支后代禁触发** + attempt 含重验分支 ⇒ 单链 ≤5 job |
| R4-2 | MAJOR | "回填时所有重叠作业都已结束"不成立（区间相交，B 可能仍在跑）；F63 自相矛盾 | §5.2 **任一 interferer 缺 fpEnd ⇒ unknown**；F63 改为断言 unknown |
| R4-3 | MAJOR | 用例与正文脱节（F47/F20/F7/F43/F44 仍引已删机制；§4.5 终结定义、§10.1 仍写 capacity 等待） | 逐处改齐，见各处 |
| R4-4 | MINOR | tryDeliver 先记账后投递；boundary 在 pi 校验 entries 前置 acked ⇒ 丢弃时既没送达也不再投递 | §7.4 记账在发起投递的同步块，**acked 只在确证送达**；boundary 改等紧随的 `agent_start`；**catch-up 绕过 watermark** |
| R4-5 | MINOR | renudgeBudget 跨 episode 残留 ⇒ 无关轮次冒出"去干 #5" | §7.4 **`agent_settled` 清零** |
| R4-6 | MINOR | §4.1 转移表被说明段截断，后半 5 行掉出表格 | 说明段挪到表下方 |

**反提案裁决**：check 判定 §5.2.1 成立且优于 `expectChanges`（"重验是重新取证而非豁免判定，完成用的是 fresh 证据，stale 从未被用来放行"）。本版补齐其要求的三处：**有界性**（R4-1）、**副作用**（优先跑 `verify.command`，避免重复 release/publish/migrate）、**capacity 死路**（重验遇容量拒 ⇒ 直接 parked）。新增 F67-F71。

### 0.5 第五轮（4 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R5-1 | BLOCKER | 失败/killed/spawn_error/恢复态四分支只写 lastFailure 不 append Evidence，而 undelivered 只认 async 证据 ⇒ **这四种结局零投递**，夜里失败后没人被叫醒、next 不下发 | §7.1 每个 job 终结都 append Evidence；**新增 `chainFinal`**，只有链终结的证据进 undelivered（避免 4 次失败=4 次唤醒）；F72-F74 |
| R5-2 | MAJOR | `interferers` 定义要求"确实写过"，缺 fpEnd 者进不了集合 ⇒ "缺 fpEnd ⇒ unknown"永不触发 ⇒ 反落 stale | §5.2 拆 `interferers[]` / `overlapUnfinished[]` 两集合两 reason；F75 |
| R5-3 | MINOR | 补偿只挂 session_start ⇒ pi 整夜不重启则通知延迟到天亮 | §5.3 / §10.2 补偿并入单 timer，窗口压到 10min；F76 |
| R5-4 | MINOR | §7.1 流程图仍写"respawn 同命令"，与 §5.2.1/F68 优先 verify.command 相反 | 字样改齐 |

check 本轮四处验算通过：链级界**恰好 5 个 job**（两种最坏走法都验过）、缺 fpEnd ⇒ unknown 方向保守可接受、记账与 ack 分离**无重复投递窗口**、`agent_settled` 清零**不会切掉合法 re-nudge**（boundary 永远早于 settle）。

### 0.6 第六轮（5 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R6-1 | MAJOR | "每个 job 终结 append"覆盖不到**两条无 job 的终结路径**（respawn spawn 抛错、重验遇 capacity 拒）⇒ 0 条 chainFinal ⇒ 静默 park，R5-1 原地复发 | §7.1 改为**统一 `finalizeChain(R)`**：按派生 `chainTerminated` 判定，无 job 时以 `rootId` 为 ref 合成证据，幂等保证每链恰一条；`spawn_error` 从 job-exit 树中单列 |
| R6-2 | MAJOR | §4.5 链终结用**枚举式**定义，漏"重验遇容量拒" ⇒ defer 永不释放（回到 BLOCKER-3 形态） | §4.5 改**派生判定** `无 running && 无 retryAt && 无待重验` |
| R6-3 | MAJOR | §5.2 stale 行缺 `&& overlapUnfinished 为空`，与 unknown 行重叠 ⇒ 按行序实现复现假 stale | 判定表补合取项；F79 组合断言 |
| R6-4 | MAJOR | 补偿进 timer 后无法区分"排队未消费"与"投递失败" ⇒ 重发 ⇒ 模型看两遍 | §5.3 补偿加 `ctx.isIdle()` 守卫；F80 |
| R6-5 | MINOR | 模型自己 park 取消链，被 kill 作业仍唤醒它 ⇒ 每次自伤 park 白烧一轮 | Evidence 加 `trigger:"self"\|"external"`，self 不进 undelivered；F81 |

另采纳两条措辞/估算修正：`overlapUnfinished` 的 reason 改"无法判定（未结束/结果未知）"（含恢复态）；轮数估算改为**任务数 × 每任务链数**（build+test 是两条链）。新增 F77-F82。

### 0.7 第七轮（3 条，本版修订）

三条同一根因：**幂等标记与链级状态被放在了会被淘汰、且会话隔离的 `evidence` 里**。

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R7-1 | MAJOR | `finalizeChain` 幂等判据读 evidence（per-task 环形 8）⇒ 双链任务必溢出 ⇒ sweep 重复合成并重复投递；跨会话时 B 看不见 A 的证据，且铁律禁止 B 写 A 的 board | §7.1 finalize **拆两步**：链级终结（`root.finalized`/`finalResult` 落 sidecar，任何会话可做、幂等）+ owner 投影（`evidenceApplied` 也在 job 侧，只有 owner 写自己 board）。Evidence 降为展示副本 |
| R7-2 | MINOR | `chainTerminated` 的"无待执行重验"无落点 ⇒ 崩溃窗口内链既不终结也无 respawn 驱动 ⇒ 永久悬置、defer 挂死 | §4.5 `root.pendingReverify` 在 stale 判定同一同步块落盘；`session_start` sweep 见到即**补 respawn**（额度尽则判终结 parked） |
| R7-3 | MINOR | `trigger` 只在内存 ⇒ 重启后 finalize 落成 external，把自己先前的决定再叫醒一次 | kill 请求落 `job.kill.requestedBy`，finalize 从 job 侧读 |

新增 F83-F86。check 本轮其余核对全部通过（判定表无重叠无遗漏、isIdle 守卫、spawn_error 单列、轮数估算与合并一致）。

### 0.8 第八轮（5 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R8-1 | MAJOR | v8 残留**两个 chainFinal 生产者**（per-job 判定表 + projectFinal）⇒ 有终结 job 的链产两条，跨 250ms 窗口即双投递 | §7.1 **per-job 证据一律 chainFinal:false**；chainFinal 只由 projectFinal 合成；undelivered 只认投影产物 |
| R8-2 | MAJOR | owner 会话**永不复用**（早上开新会话）⇒ 夜里 finalized 的链永远投不进任何 board，任务悬在死分支 ⇒ **北极星在这条早晨路径上整体落空** | §7.1.1 **孤儿链收养**：只收 finalized && !evidenceApplied && owner 不活跃的链，连带其绑定任务导入本 board，移交归属 + repair + notify；running 链不收；其余遗留列在 /vigil-todo 并提供 `/vigil-todo adopt` |
| R8-3 | MAJOR | catch-up 判据仍是 per-job，而投递已是链粒度 ⇒ 中间失败 job 的 notifyState 恒 pending ⇒ 每次启动/timer 乱补 | §5.3 扫描集改 **root 粒度**并写明；`notifyState/wakeId/notifySentAt` 只在 root 记录有效 |
| R8-4 | MINOR | pendingReverify 补 respawn **跨会话双驱动** ⇒ 两条重验 job、命令跑两遍 | §4.5 `respawnClaim` 原子认领（写后重读，输者跳过） |
| R8-5 | MINOR | 迟投影被 watermark 遮蔽（finalResult.at < watermark）⇒ 永不投递 | §7.1 投影证据 `at = now()`（R3 新近度走 per-job 证据，不受影响） |

新增 F87-F92。

### 0.9 第九轮（4 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R9-1 | MAJOR | 导入未定义 id 冲突：两个 board 各自从 1 编号，resume 会话或会话中段 adopt **必然撞号** | §7.1.1-D **导入即重编号** + blockedBy remap + `metadata.adoptedFrom` + 按任务去重 + job.taskId 同步 |
| R9-2 | MAJOR | "活跃会话表"无来源（**已核实 pi 无此 API**，grep 零命中）且收养无原子性 ⇒ 双收养 | §7.1.1-A **自建心跳**（sidecar per-session 文件，pid + heartbeatAt + startStamp）+ §7.1.1-B `adoptClaim` write-reread |
| R9-3 | MINOR | sessionId → 旧 session 文件的定位与读取方式未写（不能走 ctx.sessionManager） | §7.1.1-C 扫 sessions 目录按 header sessionId 匹配、取分支最后快照 |
| R9-4 | MINOR | 移交后旧会话重开：不会双 owner，但旧副本分叉、用户回到 A 会操作死数据 | §7.1.1-E 标 `adoptedAway` + 面板"已移交" + 冻结操作 |

check 核实：收养**不违反铁律**（绑定边迁移 + 显式追加，不覆盖旧 board），前提是 B 的原子认领；不会双 owner。R8-1/3/4/5 四处已确认修彻底。新增 F93-F96。

### 0.10 第十轮（5 条，本版修订）

| # | sev | 问题 | 修订位置 |
|---|---|---|---|
| R10-1 | BLOCKER | **文档结构损坏**：L692-915 是 §6.1-§7.1.1 的整段重复副本，其中第二个 §7.1.1 是 v8 旧文 ⇒ 实现者读到旧版即绕过 R9 全部修复 | 已删 224 行重复块；§7.1.1 尾部重复的补偿段并回 §5.3（**根因：我用 python 切块编辑引入，非设计问题**） |
| R10-2 | MAJOR | pi 挂死未退出 ⇒ timer 同死但 pid 活 ⇒ 判活跃永不收养，且 `/vigil-todo adopt` 同被 gate 挡死 | §7.1.1-F **人工 adopt 绕过 gate** + heartbeat 停更 >10min 标"疑似挂死"；保留 pid 分支（合盖睡一夜靠它） |
| R10-3 | MAJOR | 悬空依赖一律"视为未满足"与 R4 组合出死锁（最常见路径：依赖在旧 board 已 completed 未导入） | §7.1.1-D **对照旧快照解析**：completed\|deleted → 删除（视为已满足）；非终态保留悬空 |
| R10-4 | MAJOR | crash 后 15s 内重启 ⇒ heartbeat 仍新鲜 ⇒ 判活跃跳过，而收养只在 session_start 跑一次 ⇒ 整会话错过 | §7.1.1-A **收养扫描并入单 timer** |
| R10-5 | MINOR | write-reread 不是原子的（双方都见自己 ⇒ 双赢家）；respawnClaim 同病 | claim 改 **独立文件 `O_EXCL` 原子创建**（`<runDir>/claims/<rootId>.{adopt,respawn}.json`），创建失败即输者 |

check 确认 A-F 六节机制设计自洽，F93-F97 与正文一致。新增 F98-F102。

### 0.11 第十一轮（3 条 MINOR，本版修订）

check 已验证结构修复彻底（全文单一 §6/§7/§7.1.1，扫描集只在 §5.3，Job 类型中 `respawnClaim` 字段已删，F98-F102 与正文一致），本轮仅剩三条一行级修法：

| # | 问题 | 修订位置 |
|---|---|---|
| R11-1 | claim **过期收回**的竞态：`unlink + O_EXCL create` 两步之间 B 的 unlink 会删掉 A 刚建的新 claim ⇒ 双赢家在过期路径复发 | §7.1.1-B takeover 协议：`fs.rename(claim → claim+".stale."+me)` 原子竞争，成功者获重建权，ENOENT 即输者跳过 |
| R11-2 | 人工 adopt"同样走 A-E"不含 running 排除 ⇒ "疑似挂死"实为合盖睡眠，醒来后双头驱动 | §7.1.1-F 明确**人工接管同样只收终态链**，running 待终结后由 timer 归入 |
| R11-3 | 收养并入单 timer 只覆盖"有作业"的会话；自身无作业的 B 在 A 崩溃后 15s 内启动 ⇒ 无 timer ⇒ 永不复查 | §7.1.1-A `session_start` gate 失败挂**一次性 +20s 复查**（与 timer 无关） |

check 原话："三条都是一行级修法，无机制性返工；修完即可 APPROVE，不再有下一轮的问题清单。"新增 F103-F105。

---

## 1. 北极星

**走开也放心。** 夜里排一批活去睡，早上回来：该完成的已完成、该停的停在该停处、进度可信。

```
✓ #1 重构 parser   (34 passed)
✓ #2 全量回归     (218 passed)
⚠ #3 更新文档     ← 停在这，#2 的 warn 需要你拍板
```

不自动推进 = 北极星不成立 ⇒ 自动推进是必需项。

### 1.1 非目标

失败自愈／叙事摘要／决策清单 Q&A／动作黑名单／跨机器／多 agent 编排／时间成本统计。

---

## 2. 职责边界

```
vigil-todo     → 任务该不该往下走（重试用尽 / 依赖未清 / 轮数耗尽 / 模型 park）
权限层  → 这条命令能不能跑（已有 tool_call 钩子 + 项目 trust）
```

---

## 3. 十四条用户决策（不可推翻）

| # | 决策 |
|---|---|
| 1 | 北极星 = 走开也放心 |
| 2 | 硬停三条 + 模型申报 park（必带 reason） |
| 3 | parked 不占 WIP，跳过它做不依赖它的 |
| 4 | 交接面 = 面板；不写叙事摘要；用户是决策路由器 |
| 5 | 动作边界交给权限层 |
| 6 | 扩展算唯一 next，模型拍板 |
| 7 | parked 是正式第 5 状态；兼容单向 |
| 8 | 失败退避重试：立即 → 30s → 2min，重试 3 次可配；每次新 job id 各留日志 |
| 9 | 主动 kill 不重试；spawn 就失败不重试 |
| 10 | 扩展自己重跑命令（不烧 token） |
| 11 | `maxTurns: 50` 保险丝，重试不计数 |
| 12 | completed 汇总一行带证据，逐条走 `/todos` |
| 13 | `wipLimit: 3` 可配；并行判定权在模型，`defer(untilJob)` 表达串行 |
| 14 | 指纹异常 → 不自动 completed，告知但不否决 |

---

## 4. 状态机

### 4.1 转移表

| from | to | 前置条件 |
|---|---|---|
| `pending` | `in_progress` | R1 WIP 有位、R4 依赖已清、R9 无 park/defer |
| `pending` | `parked` | R7 必带 reason |
| `pending` | `completed` | R2 R3 R4 R6 |
| `pending` | `deleted` | 无 jobs 且无 evidence |
| `in_progress` | `completed` | R2 R3 R4 R6 |
| `in_progress` | `parked` | R7；**同步取消整条重试链** |
| `in_progress` | `pending` | **该任务无 running 作业且无退避链**（R14）；否则拒，文案：先 `bg_kill` 或等作业结束 |
| `in_progress` | `deleted` | 无 jobs 且无 evidence |
| `parked` | `in_progress` | R1 R4；必须无 defer 标记 |
| `parked` | `pending` | 无前置 |
| `parked` | `completed` | R2 R3 R4 R6 |
| `parked` | `deleted` | 无 jobs 且无 evidence |
| `completed` | `deleted` | 单向 |
| `deleted` | — | 终态 |

`completed → parked` 不存在。同值幂等。

**进入 `in_progress` 必刷新 `inProgressSince = now`**（含首次开工、unpark、defer 释放后重进）—— R3 新近度判定的基准点，不刷新则判据失效。

### 4.2 WIP 计数

只数 `in_progress`，`wipLimit` 默认 3 可配。
**让位前置**（R2-9）堵住"作业在跑却释放名额"的腾挪路径 —— 与 §7.8 一起封死绕开 `wipLimit` 的两个口。

### 4.3 park 与 defer

| | park | defer |
|---|---|---|
| 等 | 人的决定 | 作业**链**终结（成败都算） |
| 存储 | `status:"parked"` + `park{reason,at,from}` | `status:"pending"` + `defer{untilRoot,reason,at}` |
| 解除 | 模型显式改 status | sweep 自动，或 `defer:null` |
| **前置** | 无 | **自身无 running 作业且无退避链**（R14，R3-4） |
| 占 WIP | 否 | 否 |
| 面板 | `⚠ parked` + reason | `⏸ deferred → bg_x2` |
| 必填 | reason | untilJob + reason |

不复用 `blockedBy`：它要求依赖任务 completed，而资源冲突只要求作业跑完；复用会让 `#2` parked 把 `#5` 永久锁死。

**defer 的前置（R3-4）**：defer 同样把 `in_progress` 置 `pending` 并释放 WIP 名额，所以 R14 必须同等适用——否则“让位被拒 → 改用 defer”就是 R14 的绕过路径。
**defer 的理由永远是别人的作业**；自己还在跑就不是“等别人”，而是“想腾位”。

### 4.4 两标记互斥

- 对 `parked` 施加 defer → 拒："先 `todo({action:"update",id,status:"pending"})` 再 defer"
- 对 deferred 施加 park → 拒："先 `todo({action:"update",id,defer:null})` 再 park"

### 4.5 defer 解除：sweep 驱动

**解除条件**（其一）：
1. `untilRoot` 整条链已终结 —— **派生判定，不用枚举**（R6-2）：

   ```
   chainTerminated(R) = 链上无 running 作业
                     && 无 retryAt != null
                     && !root.pendingReverify        // ★ R7-2：落 job 侧，见下
   ```
   枚举式定义漏了"重验遇容量拒"这条路径，会让等在该 root 上的 defer 永不释放（回到原 BLOCKER-3 形态）。派生判定对**所有**终结路径成立，包括无 job 记录的那两条。

   **`pendingReverify` 的落点与崩溃窗口（R7-2）**：待重验既不是 job、也没有 `retryAt`，若只存在于"判定 stale → respawn"的同步块内，崩溃后重启会两头落空 —— 判终结则重验凭空消失，判未终结则**既不终结也无 respawn 驱动**（扫描器只扫 `retryAt`）⇒ 链永久悬置、defer 挂死。
   故：**stale 判定的同一同步块内置 `root.pendingReverify = true` 并落盘**，重验 spawn 成功即清。`session_start` sweep 见到 `pendingReverify && !finalized` 的链 ⇒ **补一次 respawn**（额度已尽则直接判终结 parked）。二选一，绝不悬置。

   **跨会话原子认领（R8-4 / R10-5）**：A、B 两会话的 sweep 可能同时看到同一条链 ⇒ 各自 respawn ⇒ 两条重验 job（额度 1 被超、命令跑两遍）。故认领用 **`<runDir>/claims/<rootId>.respawn.json` 的 `O_EXCL` 原子创建**（创建失败即输者跳过）；write-reread 不是原子的，不用它。单会话内无双驱（同步块内置位即清）。
2. `untilRoot` 在 sidecar 无任何记录 → 释放 + `repair` 日志 + 一次 notify

**驱动者**（不依赖 owner 会话 onExit）：`session_start` 全量 sweep；单 timer 内 sweep；任何 job 落盘后同步 sweep。
**用户出口**：`todo({action:"update", id, defer:null})`。

---

## 5. 数据模型

```ts
type Status = "pending" | "in_progress" | "parked" | "completed" | "deleted";

type Task = {
  id: number; subject: string; status: Status;
  description?: string; activeForm?: string; owner?: string;
  blockedBy?: number[]; metadata?: Record<string, unknown>;
  verify?: { kind: "command"; command: string };
  verifyChanged?: boolean;          // ★ R2-8：改过 verify 命令 ⇒ 禁用自动完成
  jobs?: string[];
  evidence?: Evidence[];            // 环形上限 8：**通过/中性/失败都进环**（R5-1）
                                    // 失败另存 sticky lastFailure，环溢出不丢阻断信号
  lastFailure?: { exitCode: number|null; ref: string; at: number; note?: string };
  statusSince?: number;
  inProgressSince?: number;         // 0 = 无信息（迁移态），跳过新近度判定
  park?: { reason: string; at: number; from: Status };
  defer?: { untilRoot: string; reason: string; at: number };
};

type Evidence = {
  ok: boolean;
  kind: "job" | "command" | "manual";
  origin: "async" | "tool";         // ★ R2-2：只有 async 能进入 undelivered
  chainFinal: boolean;              // ★ R5-1：仅链终结的证据触发投递（见 §7.1）
  trigger?: "self" | "external";    // ★ R6-5：模型自己 park/kill 造成的终结不唤醒自己
  at: number;
  exitCode?: number | null;
  known: boolean;
  fp: "fresh" | "stale" | "unknown";
  accepted?: boolean;
  ref?: string; note?: string;
};

type Job = {
  id: string; label: string; command: string; logPath: string; cwd: string;
  pid: number;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number|null; signal?: string|null; exitCodeKnown: boolean;
  startedAt: number; endedAt: number|null; startStamp?: string;
  fpStart?: string; fpEnd?: string;
  fpVerdict: "fresh" | "stale" | "unknown";  // ★ 回填时才计算（R3-5）
  interferers: string[];            // ★ R5-2：重叠且**确有写入**（fpStart!==fpEnd）
  overlapUnfinished: string[];      // ★ R5-2：重叠但**缺 fpEnd**（仍在跑，无法判定）
  staleReverifyOf?: string;         // ★ R3-5 反提案：本次是某 job 的 stale 重验
  taskId?: number; sessionId?: string;
  rootId: string; retryOf?: string; attempt: number;
  retryAt?: number;                 // 退避到期时刻；派生 reservedSlots 的唯一来源
  // ★ R7：以下三项是**链级权威状态**，落 sidecar（不淘汰、跨会话可见、TTL 内唯一）
  finalized?: boolean;              // R7-1：幂等标记（只在 rootId 记录上）
  finalResult?: { ok: boolean; note: string; trigger: "self"|"external"; at: number };
  pendingReverify?: boolean;        // R7-2：stale 判定置位，重验 spawn 成功即清
  // ★ R10-5：认领不落本记录，改 <runDir>/claims/<rootId>.{adopt,respawn}.json 的 O_EXCL 原子创建
  kill?: { requestedBy: "self"|"external"; at: number };  // R7-3
  evidenceApplied: boolean;
  // ★ R8-3：以下三字段**只在 root 记录有效**，per-job 不读不写
  notifyState: "pending" | "sent" | "acked";
  notifySentAt?: number; wakeId?: string;   // ★ R2-10
};

type BoardCounters = {              // ★ 随 task 快照落盘，跨重启保持
  turnsUsed: number;
  wakeWatermark: number;            // ★ 已**投递**的 async 证据最大 at（投递时推进）
  renudgeBudget: number;            // 0..1，每次投递置 1
};
```

### 5.1 两条事实源，一条铁律

Task 权威在会话分支 custom entry（`rpiv-todo-state` 超集）；Job 权威在 `/tmp/bg-run/<hash(cwd)>/jobs.json`（超集）。
**铁律**：作业真实性只由 job 侧说，任务可见性只由 task 侧说；矛盾时各自为准，绑定边取并集 + `repair` 日志，绝不互相覆盖状态。

### 5.2 指纹三态 + 延迟判定（R2-11 / R3-5）

采集：`git rev-parse HEAD` + `git status --porcelain` 哈希，作业启动/结束各一次。

**判定时机：回填时才算 `fpVerdict`**（R3-5）。作业刚结束时重叠作业可能还在跑、拿不到它的 `fpEnd`，故延到回填时算。

**但"回填时所有重叠作业都已结束"并不成立**（R4-2）：重叠是**区间相交**，A 结束时 B 可能仍在跑。故补一条诚实规则：

> **`overlapUnfinished` 非空 ⇒ `verdict = unknown`**（自动完成 + `fp:?`，reason="无法判定（未结束/结果未知）"），不假称已就绪、不猜。

不做"延到重叠组关闭再复判"——那会把自动完成决策无限期挂起，与北极星冲突；unknown 照常完成 + 显著告知已经够。

**两个集合必须分开（R5-2）**—— 同 cwd、运行区间与本作业重叠、且**非同一 `taskId`**（§7.8 允许 build+test 同任务并行）的作业，按是否拿到 `fpEnd` 分流：

| 集合 | 条件 | reason 措辞 |
|---|---|---|
| `interferers[]` | 有 `fpEnd` 且 `fpStart !== fpEnd` ⇒ **确有写入** | "期间有写入，无法归因" |
| `overlapUnfinished[]` | **缺 `fpEnd`**（仍在跑，或恢复态结果未知）⇒ **无法判定** | "无法判定（未结束/结果未知）" |

原写法把两者混为一个 `interferers`，而它的定义要求"确实写过东西"——缺 `fpEnd` 的作业恰恰判不出写没写，按定义进不了集合 ⇒ "缺 fpEnd ⇒ unknown"这条规则**永不触发** ⇒ 反而落进 stale，白跑一整条取证命令。故必须拆。

| verdict | 条件 |
|---|---|
| `fresh` | 指纹未变 **且** git 目录 **且** 采集成功 |
| `stale` | 指纹变了 **且 `interferers` 与 `overlapUnfinished` 两集合皆空**（R6-3：缺后一项会与 unknown 行重叠，按行序实现即复现假 stale） |
| `unknown` | 指纹变了但 `interferers.length > 0` **或 `overlapUnfinished.length > 0`** ／ 非 git ／ git 调用失败 |

**已知盲区（明写）**：`--porcelain` 不含 ignored 文件（`dist/`、`.env`、`node_modules`）。指纹只证明 **tracked 工作区未变**，是保守提示不是充分保证。

**裁决点 = 是否叫醒人**：

| fp | 自动 completed | 告知 |
|---|---|---|
| `fresh` | ✅ | 汇总行 `all exit 0` |
| `unknown` | ✅ | 汇总行 **`⚠ N 条 fp:?`**，`/todos` 可逐条下钻；唤醒消息附一行 |
| `stale` | ❌ → **先自动重验一次**（§5.2.1） | 重验仍 stale 才 parked 等人 |

**与决策 14 的关系（收窄解释，不是推翻）**：决策 14 说“指纹变过 → 不自动 completed”。收窄为 **“可归因地变过（stale）→ 不直接自动完成（先重验）；不可归因（unknown）→ 自动完成但显著告知”**。理由：`wipLimit:3` + `maxConcurrentJobs:10` 下若 unknown 也否决，典型夜晚近乎全量 unknown ⇒ 几乎 nothing 自动完成 ⇒ 北极星失效。

#### 5.2.1 对 R3-5 的反提案：stale 自动重验，而非 `expectChanges` 豁免

check 建议加任务级 `expectChanges:true`，把“变了 + 无写入干扰者”判 `self` 并自动完成。**我接受问题、不接受这个修法**：

- 问题成立：排除同 taskId 后，“自己在测试期间又改了代码”会落入 stale，编码类任务频繁被冻结。
- 但 `expectChanges` 混淆了两件事：**“预期会改文件” ≠ “测试期间改文件是安全的”**。测试跑到一半时代码被改，无论是否预期，那份 `exit 0` 就是不可信的。用声明豁免它等于把证据完整性卖掉。

**反提案（保完整性、同时解决频率）**：stale 不直接 parked，而是**扩展自动重跑一次取证命令**（不改代码，复用重试基础设施）：

```
fp stale → 自动 respawn 取证命令（新 job id，同 rootId，标 staleReverifyOf）
            → 重验 fresh   → 自动 completed（汇总行标 ↺ reverified）
            → 重验 unknown → 自动 completed + fp:?
            → 重验仍 stale → parked(reason="工作区持续变动，证据无法确认")
```

**取证命令的选择（R4 附带意见②：副作用）**：重验会**再执行一遍已经成功过的命令**，对 `release` / `publish` / `migrate` 类是失败重试所没有的新风险。故：

1. 任务有 `verify.command` → **优先跑它**（那是用户声明的幂等检查）
2. 无 `verify` → 跑原 `job.command`，并在面板/消息标注"重验执行了原命令"

**有界性（R4-1 BLOCKER：上限必须落在链上）**：`staleReverifyOf` 若只是 per-job 标记，则 `exit0+stale → revert → exit≠0 → retry（无标记）→ exit0+stale → 再 revert` 可无限自我复制。故上限与继承规则全部落在 **`rootId` 链**上，且**均为派生值**（数链上的 job 记录，崩溃不泄漏）：

| 链级上限 | 派生口径 | 默认 |
|---|---|---|
| `attempt` | 失败重试序号，**含重验分支内的失败重试** | ≤ `1 + retries` = 4 |
| `chain.reverifies` | `count(rootId===R && staleReverifyOf != null)` | ≤ `staleReverify` = 1 |

**继承规则**：沿 `retryOf` 向上走，只要任一祖先带 `staleReverifyOf`，该 job 即属**重验分支**；**重验分支的后代永不再触发新的重验**。
**消耗口径**：重验 job 本身 `attempt` 继承父值（不增）；重验分支内的失败重试照常 `attempt++`，撞 4 即 parked。
⇒ 单链 job 总数 ≤ `4 + 1 = 5`，**有界**。`turnsUsed` 只闸投递不闸 spawn，故不能充当此处的界。

**capacity 死路（R4 附带意见③）**：重验走 spawn 路径，会被"新 spawn 准入"拒（R3-2 后新 spawn 不排队）。此时**直接 parked(reason="无空闲槽位重验")**，不静默停在 in_progress。

- 重验**不消耗 `turnsUsed`**（扩展自己跑，模型没醒）
- 为什么能解决频率：模型通常已停手去处理下一个任务，重验时工作区已静止 ⇒ fresh ⇒ 自动完成，人不被叫醒
- 为什么不破完整性：没有豁免任何判定，只是**重新取一份可信证据**；完成用的始终是 fresh/unknown 证据，**stale 证据从未被用来放行**

**check 第四轮已裁定此反提案成立且优于 `expectChanges`；上述三处补齐为本版新增。**

### 5.3 两个去重字段 + ack 信号（R2-10 / R3-3）

| 字段 | 语义 | 置位 |
|---|---|---|
| `evidenceApplied` | 结果是否已写入 evidence | 回填同一同步块内 true |
| `notifyState` | 唤醒投递状态 | `pending` → 投递 → `sent`（记 `notifySentAt`、`wakeId`）→ **ack** → `acked` |

**ack 分两条路（已核实源码）**：

| 投递通道 | ack 信号 |
|---|---|
| `sendMessage`（idle 或 busy steer） | `message_start` / `message_end` 中 `customType==="vigil-todo-wake"` 且 `details.wakeId` 匹配 ⇒ 批量置 `wake.jobs[]` 为 acked。<br>依据：busy 路径消费 steer 只发这两个事件（`agent-loop.js:121-123`），**不发 `agent_start`** |
| `agent_before_settle`（boundary） | **紧随其后那次 `agent_start`** 置 acked（R3-3 / R4-4）。entries 合法才会有 agent_start；被丢弃则留 `sent` 由 catch-up 补发。<br>依据：boundary entry 经 `_refreshFinalizedContext` 入 messages 后 `continue()`，而 `runAgentLoopContinue:71-79` 只发 `agent_start`/`turn_start`，**无 `message_start`** ⇒ 等不到信号 |

一条合并消息可含多个 job ⇒ `wake.jobs: string[]` 批量置位。

**补偿的扫描集必须是 root 粒度（R8-3）**：投递已是**链粒度**（一条 chainFinal），若 `notifyState` 仍按 per-job 读，则中间失败 job 的 `notifyState` 恒 `pending`（它们从不进任何唤醒）⇒ 按"补发 pending"字面实现会在每次 `session_start`/timer 对**无话可说的 job 乱补**。

```
扫描集 = roots(mine) where finalized && (
             !evidenceApplied                    → 先 projectFinal
          || notifyState !== "acked"             → 补发（sent 需 >10min 守卫 + isIdle）
         )
```

**类型约束**：`notifyState` / `wakeId` / `notifySentAt` **只在 root 记录上有效**，per-job 记录不读不写这三个字段。

**补偿时机（R5-3：不能只挂 session_start）**：`session_start` **与单 timer** 都跑上述扫描集。
只挂 session_start 时，sendMessage 抛错或 entries 被丢弃要等下次重启才补 —— pi 整夜不重启 ⇒ 通知延迟到天亮。并进已经在扫 retryAt/defer 的那个 timer，窗口从"一次会话"压到 10min。
**补偿必须加空闲守卫（R6-4）**：条件再加 `ctx.isIdle()`（或 `!ctx.hasPendingMessages()`）。否则"已投递但被长工具调用排住、尚未消费"与"投递失败"不可区分 —— `sent && >10min && 未 acked` 会命中仍在队列里的 steer，同一条 wake 被重发，模型看两遍甚至重复开工。只对**真正无人接收**的补发。
`acked` 永不重发 ⇒ F8 恰一次成立。补偿绕过 watermark 且不再推进它。

---

## 6. 纪律：工具层强制

### 6.1 两层防线

L1 `tool_call` 预检 = 尽力而为的友好提示，**非权威**，且**跳过带 `parentToolCallId` 的嵌套调用**。
L2 `todo.execute()` 内**同步**读→校验→写→`appendEntry`（无 `await`）= **唯一权威**。
不设 `executionMode:"sequential"`（P0 附带发现 A：会串行化整批）。L2 自身充分：JS 单线程 + 临界区无 await。

### 6.2 规则表

| # | 规则 | 判定 |
|---|---|---|
| R1 | WIP 上限 | `→in_progress` 且已有 `wipLimit` 个 → 拒 |
| R2 | 失败不可 completed | `lastFailure` 存在且无 `at > lastFailure.at` 的通过证据 → 拒 |
| R3 | 完成需证据 | 绑过 job 或有 verify → 需通过证据且：<br>**`inProgressSince === 0`（迁移态）→ 跳过新近度判定**（R2-7）<br>否则 job 证据：`job.startedAt >= inProgressSince && evidence.at >= job.startedAt`<br>verify 证据：**`evidence.at >= inProgressSince`**（R2-6） |
| R4 | 依赖未清不许推进 | 任一 blockedBy 的 status ∉ `{completed, deleted}` → 拒 |
| R5 | 未知退出码不算证据 | `known:false` → 不满足 R3 |
| R6 | stale 需显式接受 | `fp==="stale"` 且未 accepted → 不满足 R3（先走 §5.2.1 自动重验）；`accept:"stale"` 放行留痕。`unknown` 不拦（§5.2） |
| R7 | park 必带 reason | 空 → 拒 |
| R8 | defer 必带 untilJob + reason | 缺任一 → 拒；untilJob 须存在 |
| R9 | parked/deferred 不许直接开工 | 有 park → 需显式改 status；有 defer → 拒 |
| R10 | 错误即错误 | 拒绝返回 `{isError:true, content, details:{error}}` |
| R11 | 绑定唯一 | 一个 job 不能绑两任务 |
| R12 | 变更必落快照 | 同一同步块 `appendEntry`（含 `BoardCounters`） |
| R13 | 标记互斥 | park 与 defer 不共存 |
| R14 | 让位与 defer 前置 | `in_progress→pending` **与施加 defer** 均要求自身无 running 作业且无退避链（R2-9 / R3-4） |
| R16 | 只读字段 | §6.7 列出的字段模型不可写，传入即拒 |
| R17 | 移交任务冻结 | `metadata.adoptedAway` 的任务拒绝一切变更，提示归属会话（§7.1.1-E） |
| R15 | verify 改动禁用自动完成 | `verifyChanged:true` 的任务**不自动 completed**，须模型显式完成（R2-8） |

### 6.3 证据来源

| 来源 | known | origin |
|---|---|---|
| job 退出码（`exit`/`close`） | true | **async** |
| job 恢复态 | **false** | async |
| `todo verify` | true | **tool** |
| manual（accept / verify 改动留痕） | — | tool |

**P0 Q5**：`executeTool` 需模型发起的工具调用上下文 ⇒ 回调里不能跑命令；重验必须模型调 `verify`。

### 6.4 拒绝文案（真实调用形态，R2-12）

```
✗ #2 is blocked by #1 (in_progress)
  → todo({action:"update", id:2, removeBlockedBy:[1]})
✗ WIP full (3/3): #2 #5 #7
  → todo({action:"update", id:7, status:"parked", reason:"…"})
✗ #1 has unresolved failure (bg_x2 exit 1, 4 attempts)
  → todo({action:"verify", id:1})
✗ #1 evidence stale (workspace changed while bg_x2 ran alone)
  → todo({action:"update", id:1, status:"completed", accept:"stale"})
    或 todo({action:"verify", id:1})
✗ park requires reason
✗ #5 is deferred → bg_x2
  → todo({action:"update", id:5, defer:null})
✗ #7 has a running job; cannot yield or defer
  → bg_kill({job_id:"bg_x9"}) 或等它结束（defer 的理由只能是别人的作业）
✗ capacity full (10/10 jobs)
  → bg_kill 释放，或稍后再试（任务保持 pending，未被 park）
```

### 6.5 统一工具面

**action 枚举只加 `verify`**，其余全走 `update` + 字段。

| 意图 | 唯一写法 |
|---|---|
| 开工 | `todo({action:"update", id, status:"in_progress", activeForm?})` |
| 完成 | `todo({action:"update", id, status:"completed"})` |
| 接受 stale 完成 | `todo({action:"update", id, status:"completed", accept:"stale"})` |
| park | `todo({action:"update", id, status:"parked", reason:"…"})` |
| unpark 接着干 | `todo({action:"update", id, status:"in_progress"})` |
| unpark 先不干 | `todo({action:"update", id, status:"pending"})` |
| 让位 | `todo({action:"update", id, status:"pending"})`（R14） |
| defer | `todo({action:"update", id, defer:{untilJob:"bg_x2", reason:"…"}})` |
| 取消 defer | `todo({action:"update", id, defer:null})` |
| 改验证命令 | `todo({action:"update", id, verify:{kind:"command", command:"…"}})`（R15 副作用） |
| 重验 | `todo({action:"verify", id})` |
| 起作业 | `bg_run({task_id, command, label?})` |
| 中止链 | `bg_kill({job_id})` — 收 rootId 或链上任意 id |

### 6.6 verify 命令改动的副作用（R2-8）

允许改（typo 是真实需求），但改动时在同一同步块内：
1. 写一条 `manual` 证据，note = `verify command changed: <old> → <new>`
2. 置 `task.verifyChanged = true` ⇒ **该任务此后禁用自动完成**（R15），须模型显式 `update(status:"completed")`，仍受 R2/R3 约束
3. completed 汇总行标 `verify changed`

杜绝"失败 → 把命令改成 `true` → verify 绿 → 自动完成"的静默洗白。

---

### 6.7 update 的只读字段集合（R3 附带意见）

以下字段**只能由扩展写**，模型传入即拒（R10）：

```
jobs, evidence, lastFailure, inProgressSince, statusSince,
verifyChanged, park.at, park.from, defer.untilRoot, defer.at
```

模型可写：`subject / description / activeForm / owner / metadata / blockedBy / addBlockedBy / removeBlockedBy / status / reason / accept / verify / defer{untilJob,reason}`。
注：typebox `Type.Object` 默认 `additionalProperties:false` 会拦未声明字段，但上述字段**已在 schema 里**（用于展示），所以必须显式列入只读集——这是真正的约束点，不能靠 schema 兼容。

---

## 7. 推进循环

### 7.1 作业终结 → 回填

```
job exit
 ├─ known && code===0
 │   ├─ fp fresh|unknown → ok 证据(async) → R2/R3/R4/R6/R15 过 → 自动 completed
 │   └─ fp stale
 │        ├─ 链重验额度未用尽 → 自动 respawn **取证命令**（§5.2.1：优先 verify.command）
 │        │                        不写完成、不叫醒人、不消耗 attempt/turnsUsed
 │        └─ 已用尽 → parked(reason="工作区持续变动，证据无法确认")
 ├─ known && code!==0
 │   ├─ attempt <= retries → 写 lastFailure → 退避 respawn（新 id，同 rootId）
 │   └─ 用尽 → 写 lastFailure → 自动 parked，reason="N 次均失败 · <日志末行摘要>"
 ├─ killed → 不重试、**不写 lastFailure** → 链终结 → parked(reason="killed")
 └─ !known（恢复态） → 不重试 → 链终结 → parked(reason="退出码未知，需重验")
```

**不在 job-exit 树内的两条终结路径**（R6-1：它们没有 exit，也没有 job 记录）：

```
respawn 时 spawn 抛错  → 链终结 → parked(reason="spawn failed")
重验遇 capacity 拒     → 链终结 → parked(reason="无空闲槽位重验")
```

两者都**必须经 `finalizeChain(R)`** 合成 chainFinal 证据（ref=rootId），否则静默 park 无唤醒。
注：`capacity 超时` 分支已删（R3-2：respawn 永不遇 capacity，新 spawn 遇 capacity 直接 isError 不排队）。

**人工优先（R2-5，扩围）**：回填时若任务状态 **∉ `{in_progress}`**（即已是 parked/pending/completed/deleted）→ **只记 evidence/note，绝不改状态、绝不覆盖 `park.reason`**。
理由：park 是先写 parked 再异步 kill，exit 回调晚到不得改写 reason —— parked reason 是北极星的全部交接物。

**killed 不写 lastFailure**：主动叫停不是失败，否则该任务被 R2 永久阻断。

**每个 job 终结都 append 一条 Evidence（R5-1 BLOCKER）**：包括 `ok:false` 的失败 / killed / spawn_error / 恢复态四个分支，`origin:"async"`。
原设计只写 `lastFailure` 不 append Evidence，而 `tryDeliver` 的 `undelivered` 只认 async 证据 ⇒ **这四种结局一次投递都不产生** ⇒ 夜里作业失败用尽后 parked，却没人被叫醒、next 也不下发 ⇒ 天亮前什么都不再跑。§7.5 的"失败附日志尾"那条消息根本没有触发者。

**链终结由统一 finalizer 判定，不靠 per-job 分支（R6-1）**：有两条终结路径**根本没有 job 记录** —— (a) respawn 时 `spawn` 直接抛错；(b) 重验遇 capacity 拒。若只在"job 终结"时 append，这两条会产生 **0 条 chainFinal ⇒ 静默 park**，R5-1 的毛病原地复发。

```
// 第一步：链级终结（任何会话都可做，权威在 sidecar）
finalizeChain(R):
  if (!chainTerminated(R)) return          // §4.5 派生判定
  root = job(R)
  if (root.finalized) return                // ★ R7-1 幂等标记在 job 侧，不在 evidence
  root.finalized = true
  root.finalResult = { ok, note: 终结原因,
                       trigger: root.kill?.requestedBy ?? "external",  // ★ R7-3
                       at: now }
  save()                                    // 原子写

// 第二步：投影到 owner 会话（只有 owner 能写自己的 board —— 铁律）
projectFinal(R):
  root = job(R)
  if (!root.finalized || root.evidenceApplied) return
  if (currentSession !== root.sessionId) return   // 别的会话不碰 owner 的 board
  append Evidence{ ok: root.finalResult.ok, origin:"async", chainFinal:true,
                   ref: R, trigger: root.finalResult.trigger,
                   note: root.finalResult.note,
                   at: now() }   // ★ R8-5：投影时刻，非 finalResult.at
  root.evidenceApplied = true
  → 进入 undelivered 判据
```

**为什么幂等标记必须在 job 侧（R7-1）**：`evidence` 是 per-task **环形上限 8**，双链任务（2×5 job）必然溢出，chain-1 的 chainFinal 被挤掉后，任何再次触及该链的 sweep（尤其 `session_start` 全量）会**再合成一条并再投递一次**。同 cwd 多会话更糟：链在共享 sidecar、evidence 在 owner 会话分支，B 会话的 sweep 看不见 A 的证据。
⇒ `finalized` / `finalResult` / `evidenceApplied` 全部落 sidecar：**不淘汰、跨会话可见、TTL 内唯一**。Evidence 只是 owner 会话里的**展示副本**。
⇒ owner 不在线时链照样终结（第一步），投影与唤醒等 owner 启动后由 catch-up 完成（第二步 + `notifyState`）。

#### 7.1.1 孤儿链收养（R8-2 / R9：早晨路径的关键）

**问题**：owner 会话**永不复用**时（早上在同 cwd 开新会话，旧分支不再打开），夜里 `finalized` 的链永远投不进任何 board —— 任务悬在死分支、证据与唤醒永久缺失、defer 释放也只写 owner board ⇒ 北极星在这条最典型的路径上整体落空。

##### A. 活跃性判定：自建心跳（R9-2，已核实 pi 无此 API）

`ReadonlySessionManager` 的方法全部作用于**当前会话**，`dist/core` 与 `extensions` 类型里没有 `listSessions` / `activeSessions` 类接口（grep 零命中）。故自建：

```
sidecar/<projectHash>/sessions/<sessionId>.json   { pid, startStamp, heartbeatAt }
刷新：随既有单 timer 写入（1s；无 timer 时由 session_start 写一次）
活跃判定：process.kill(pid,0) 存活 || now - heartbeatAt < 15s
          （startStamp 复用 §10.1 的防 pid 复用机制）
清理：session_shutdown 删文件；超时文件视为不活跃

**收养扫描的时机（R10-4）**：**并入单 timer**，不只跑 `session_start`。
crash 不删心跳文件 ⇒ 15s 内重启时 heartbeat 仍新鲜 ⇒ 判活跃 ⇒ 跳过；若收养只在 `session_start` 跑一次，**本会话永不再试**，孤儿链悬到下次重启 —— 而这是最常见的崩溃恢复路径。有作业时 timer 本来就在跑，让它复查即可。
**且 `session_start` 的收养 gate 失败时挂一次性 +20s 复查（与 timer 无关）**（R11-3）：timer 仅在有 running/retryAt 时运行，若 B 会话自身无任何作业，在 A 崩溃后 15s 内启动时判 A 活跃跳过、之后 B 无 timer ⇒ 永不复查。一次性复查与 timer 存在与否无关，封掉这个残余。
（15s 的误判方向是**保守**的：只会推迟收养，不会误收。）
```

##### B. 原子认领（R9-2）

A、B 两会话可能同时通过活跃性 gate ⇒ 双收养（双投影、双唤醒、双份任务）。
**write-reread 不是原子的**（R10-5）：A 写→A 读见自己、B 写→B 读也见自己，双方都当赢家（tmp+rename 整文件写没有 CAS）。故 claim 改用**独立文件 `O_EXCL` 原子创建**：

```
claim 文件：<runDir>/claims/<rootId>.adopt.json
fs.open(path, "wx")   // O_EXCL：已存在即抛错 ⇒ 创建失败者就是输者，直接跳过
内容：{ by: sessionId, at, pid }
释放：完成后 unlink。
**过期收回必须原子（R11-1）**：若"判过期 → unlink 旧的 → O_EXCL 建新的"，则两会话同时判同一 claim 过期后，B 的 unlink 会删掉 A 刚建的新 claim ⇒ 双赢家，正是 R10-5 要消灭的形态在过期路径复发。故：

```
takeover 协议：
  判过期 → fs.rename(claim, claim + ".stale." + me)
           成功 → 获得重建权；失败(ENOENT) → 输者跳过
  再 O_EXCL 创建自己的 claim
```

rename 在 POSIX 上是原子的 ⇒ 只有一个会话能把它移走。
```

`respawnClaim` **同样改为 O_EXCL**（§4.5，同病）。两个 claim 文件名后缀不同（`.adopt` / `.respawn`），语义互斥（respawn 只作用于未终结链、adopt 只收已终结链），**不互相覆盖**。

**claim 文件不进 `jobs.json`**（避免整文件读改写竞态）；GC 随 §10.1 的 TTL 清理过期 claim。

##### C. 定位旧 board 快照（R9-3）

**不能走 `ctx.sessionManager`**（它只管当前会话）。
→ 扫 `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`，按 header 的 `sessionId` 匹配到 `root.sessionId` 对应文件，走该文件**当前分支**取**最后一条** `rpiv-todo-state` 快照 entry。

##### D. 导入即重编号（R9-1）

两个 board 各自从 1 编号，`/vigil-todo adopt` 在会话中段执行、或 `session_start` 发生在 resume 会话（board 非空）时**必然撞号**。

```
多条链绑同一任务 → 先按任务去重，再导入
for task in toImport:
    oldId = task.id
    newId = board.nextId++
    task.id = newId
    task.metadata.adoptedFrom = { session: oldSessionId, id: oldId }
    blockedBy 全部按映射表 remap
    悬空依赖（旧 id 未被导入）**对照旧快照解析**（R10-3）：
      旧 board 中 completed|deleted → 从 blockedBy **删除**（视为已满足）+ metadata 记录
      非终态                        → 保留悬空（`removeBlockedBy` 是现成出口）
    ※ 不做解析而一律"视为未满足"会与 R4 组合出死锁：最常见的情形正是
      "依赖在旧 board 已 completed、没有链、未被导入" ⇒ 新任务永不可推进，
      且该依赖不在新 board、无法被 complete（第一轮 BLOCKER-2 换路径复发）
    链上 job.taskId 同步指向 newId
```

##### E. 移交与旧副本冻结（R9-4）

移交后 `root.sessionId = me`，旧会话 A 若再打开：
- **不会双 owner**（`projectFinal` 的会话校验会让 A 跳过，投递/唤醒无重复）
- 但 A 的 board 残留旧副本（仍 `in_progress`）会与 B 的导入副本**分叉** ⇒ A 启动时发现本 board 任务的链已归属别的活跃会话 → 该任务标 `metadata.adoptedAway`、面板注明"已移交"、**冻结操作**（R10 拒绝其变更并提示去哪个会话）

##### F. 边界

- **只收 `finalized`（终态、不会再变）的链**；running 链不收，避免两会话驱动同一进程
- **只导入这些链绑定的任务**，不是旧 board 全量 —— 避免把无关旧任务塞进新话题
- 其余旧任务在 `/vigil-todo` 与 `/bg` 显式列为"上一会话遗留 M 个未完成任务"，提供 **`/vigil-todo adopt`** 一键全量接管（同样走 A-E）

**挂死会话的出口（R10-2）**：pi 挂死但未退出时 **timer 同死** ⇒ heartbeat 停更，但 `kill(pid,0)` 仍存活 ⇒ 判活跃 ⇒ 永不收养；若 `/vigil-todo adopt` 也走同一 gate，**人工通道同样被挡死**。故：
- `pid` 存活但 heartbeat 停更 **> 10min** ⇒ 标为**"疑似挂死"**，在 `/vigil-todo` 里显式提示可接管
- **`/vigil-todo adopt`（人工命令）绕过活跃 gate**，并强提示"原会话疑似挂死，确认接管？"（人工确权）。**但人工接管同样只收终态链**（R11-2）——"同样走 A-E"不含 running 排除（那是 F 自己的规则），若人工把 running 链一并接管，而"疑似挂死"实为**合盖睡眠**，醒来后两会话同时驱动同一进程（kill/respawn 双头）。running 链待其终结后由 timer 自动归入。
- `pid` 探测分支**必须保留**：合盖睡一夜、timer 停摆但进程其实正常，全靠它不误收
- 与铁律的关系（check 已核实）：收养是**绑定边迁移 + 显式追加**，job 侧只改归属字段（铁律明允许 repair + 日志），task 侧是向新 board **追加**、不覆盖旧 board 任何状态；前提是 B 的原子认领补上，否则"两侧各自为准"会被竞态打破

### 7.2 重试链

`retries` 默认 **3**（额外次数，**总尝试 4 次**）。间隔：1→2 立即，2→3 30s，3→4 2min。
无条件重试，零日志启发式。每次新 job id、同 `rootId`、日志各自保留。

**容量与 spawn 分流（R2-4 / R3-2）**：

| 情况 | 处置 |
|---|---|
| **新** spawn 遇 `capacity` | 工具层 `isError`，**不推状态、不动链、不 park**，任务留 pending（不排队） |
| **respawn** | **永不遇 capacity**（见下方准入规则），因此不存在“容量等待” |
| `spawn_error`（真异常） | 链终结 + parked(`spawn failed`) |

→ `capacityWaitSince` 与 `retryCapacityWaitMs` **删除**（R3-2：respawn 不再排队，它们是死代码）。

**预留槽位为派生值**：`reservedRetrySlots = count(jobs.retryAt != null)`，**不持久化**，启动/落盘后重算 ⇒ 崩溃不泄漏。

**准入规则（R3-2 修自锁）**：

```
新 spawn：  runningCount + reservedRetrySlots < maxConcurrentJobs
respawn：  先摘下自己的 retryAt（本链不再计入 reserved），再判 runningCount < max
```

为何必须摘：否则 max 条链同时退避时（0 running / 10 reserved），每条 respawn 都把自己算进容量 → 全判不足 → 重试一次都没跑。一个共同原因（网络/环境变量/磁盘满）同时打挂一批作业即可触发。

**respawn 调度者（R2-3）**：`session_start` 与单 timer **都扫 `retryAt <= now` 即 respawn**。
⇒ pi 关过一夜后链仍能推进到终结 ⇒ defer 能释放。

**stale 重验（§5.2.1）**：同 `rootId`、标 `staleReverifyOf`，**不消耗 attempt**，上限 `staleReverify` 默认 1。

**中止链**：`bg_kill`（收 rootId 或链上任意 id）→ kill running + 清 `retryAt` + 释放槽；`park` 在同一同步块内做同样的事。
**重试不消耗 `turnsUsed`**。面板显示 `↻ retry 2/4`。

### 7.3 next 计算

```
if (inProgressCount >= wipLimit || capacityFull) → next = null
else next = tasks.filter(t =>
    t.status === "pending" && !t.park && !t.defer
 && (t.blockedBy ?? []).every(id => status(id) ∈ {completed, deleted})
).sort(by id asc)[0]
```

WIP/容量满 → 文案"WIP 满 (3/3)，先 park 一个或等一个完成"／"capacity 满"，**不写"开干"**。
满且无新异步证据 → **不唤醒**。

### 7.4 唤醒：四通道 + 投递判据

| 场景 | 通道 |
|---|---|
| 空闲 | `sendMessage(..., {deliverAs:"steer", triggerTurn:true})` |
| 正在跑 | 同上（turn 边界消费） |
| 即将 settle | `agent_before_settle` → `{entries:[custom_message], continue:true}` |
| pi 关过 / 发送失败 | `session_start` 对账（§5.3） |

**合并**：250ms 窗口内完成的多个作业合成**一条**消息（带 `wakeId` + `jobs[]`）。

#### ① `continue:true` 必须配一条 `custom_message` entry

正常一轮以 assistant 收尾 ⇒ `canContinue:false` ⇒ 只给 continue 会被丢弃并报 boundary 错。custom message 在 LLM 投影里是 **user 角色**（`messages.js:89-96`），追加它才把 `finalRole` 翻成 user。**成对，缺一不可。**

#### ② watermark 只在**投递时**推进（R3-1 重写）

v3 的缺陷：充值在"证据到达"时、而 `sendMessage` 投递不扣配额 ⇒ 一次作业完工被推 3 遍（1 次 steer + 2 次 boundary），50 轮在 ~17 次唤醒就熔断。**删除 `wakeQuota`**，改为单一投递判据：

```
BoardCounters { turnsUsed, wakeWatermark, renudgeBudget }   // 随快照落盘

// 两个通道（sendMessage / boundary）共用同一判据，别无二致
tryDeliver(trigger):
  if (turnsUsed >= maxTurns) return NONE            // ★ 硬闸门，第一行

  undelivered = 证据 where origin==="async" && chainFinal
                        && trigger!=="self" && at > wakeWatermark
  if (undelivered.nonEmpty):
      wakeWatermark = max(undelivered.at)           // ★ 投递时才推进
      turnsUsed++
      renudgeBudget = 1                             // 本次唤醒配一次 re-nudge
      return DELIVER(合并消息含这些证据 + next, 新 wakeId)

  if (trigger === "boundary" && renudgeBudget > 0
      && 上一轮模型无推进动作 && next != null):
      renudgeBudget--
      turnsUsed++
      return DELIVER(re-nudge, 新 entry)

  return NONE

boundary handler:  tryDeliver("boundary") === NONE ? undefined
                                                  : { entries:[新 custom_message], continue:true }
scheduler:         tryDeliver("async") → sendMessage
```

**记账与 ack 的时机（R4-4）**：`watermark` / `turnsUsed` 在**发起投递的同步块内**记账（防止 entries 被丢弃时反复重投造成循环）；**`acked` 只在确证送达时**置位：

| 通道 | acked 时机 |
|---|---|
| `sendMessage` | `message_start/end` 匹配 `wakeId` |
| boundary | **紧随其后那次 `agent_start`**（entries 合法才会有它）。entries 被 `{entries:[],continue:false}` 丢弃 ⇒ 无 agent_start ⇒ 留在 `sent` |

**投递失败不会丢通知**：catch-up **绕过 watermark**，只按 `notifyState`（`pending`，或 `sent` 且超 10min 未 acked）补发，且补发不再推进 watermark。⇒ 即使 sendMessage 抛错或 entries 被丢弃，证据仍会被补偿通道送达。

**不变量**：
- 一条 async 证据**只被正常通道投递一次**（watermark 单调 + 投递时推进）；失败由 catch-up 兜
- busy 路径：steer 投递后 watermark 已推进 ⇒ boundary 时 `undelivered` 为空 ⇒ **不重复投递**
- 每次唤醒最多 1 次 re-nudge（`renudgeBudget` 0..1）；**`agent_settled` 一律清零**（R4-5）——否则落盘的 1 会在很久之后某个无关轮次被消费，冒出"去干 #5"。只有投递所开启的那一轮可用
- tool 证据（verify / manual，`origin:"tool"`）**永不进 undelivered** ⇒ 杜绝 verify 自持环
- 归零只由 `input` 事件触发（§7.7），**绝不用 `agent_start`**（continue 必发它）

**收敛论证**：每条 async 证据恰好产生 1 次投递（+ 最多 1 次 re-nudge）；async 证据只能由作业终结产生，而作业数有限（任务数 ×（重试 4 + stale 重验 1））⇒ 总投递次数有界；即使模型不推进，`renudgeBudget` 也只剩 1。跨唤醒的总量再由 `turnsUsed >= maxTurns` 在**两个通道的第一行**硬截断。三道门都是可执行判定。

**正常夜晚的轮数估算**：主投递数 = **任务数 × 每任务作业链数**（同任务 build+test 并行是两条链，各投一次），再加少量 re-nudge。12 任务单链 ⇒ 12～20 轮；12 任务双链 ⇒ 24～32 轮，仍在 §7.7 的 50 轮保险丝内。250ms 窗口会把同时终结的链合并成一条。

### 7.5 唤醒消息（真实调用形态）

```
[vigil-todo] #2 全量回归 ✓ exit 0 · 3m12s (bg_x2)  fp:fresh
next: #5 清理旧分支 (pending, unblocked)
→ 开干: bg_run({task_id:5, command:"…"})
  需人拍板: todo({action:"update", id:5, status:"parked", reason:"…"})
  冲突需串行: todo({action:"update", id:5, defer:{untilJob:"bg_x7", reason:"…"}})
```

stale（自动重验已用尽才会看到这条）：

```
[vigil-todo] #2 exit 0，但工作区持续变动，重验后仍无法确认证据 (fp a3f9→b71c→e40d)
      → 已 parked。你定：
        todo({action:"update", id:2, status:"completed", accept:"stale"})
        todo({action:"verify", id:2})
```

首次 stale **不叫醒人**，扩展自动重验一次（§5.2.1）；重验 fresh 则自动完成，汇总行标 `↺ reverified`。

unknown：按 reason 分别措辞 —— `fp:unknown（bg_x9 期间有写入，无法归因）` 或 `fp:unknown（bg_x9 无法判定：未结束/结果未知）`，**照常自动完成**。
失败：附日志尾（默认 20 行，按字节从尾读 ≤8KB，不读全文件）。预算 ≤1200 token。

### 7.6 re-nudge

模型被唤醒后一轮内无任何推进动作（`bg_run` / `update(status)` / `update(defer)` / `verify`）且 next 仍存在 → 用 boundary 再推**一次**，消耗 `renudgeBudget`（每次投递置 1）。
**必须带一条新的 `custom_message` entry**（不能复用上一条）。
`park` / `defer` 算推进动作，不触发。受 §7.4 三道门约束。

### 7.7 预算（R2-1 / R3-6）

**单一计数器 `turnsUsed`**，随快照落盘、跨重启保持。
递增点：`tryDeliver` 返回 DELIVER 时（两通道共用）。
闸门点：`tryDeliver` **第一行**（是则两通道同时生效）。
`maxTurns` 默认 50。达上限 → 停止唤醒，面板标"达轮数上限"，任务状态不变（等人接手）。重试与 stale 重验不计数。

**归零信号（R3-6 修正）**：用 **`input` 事件**且 `source ∈ {interactive, rpc}`。
不用 `before_agent_start{messageType:"user"}` —— 它只在 `_prepareRun` 的 prompt 路径出，**模型正在跑时用户键入走 steer 排队、不经过它** ⇒ “边看边纠偏”的 session 永不归零 ⇒ 50 轮后静默停摆。
已核实：`InputEvent` 带 `source: "interactive"|"rpc"|"extension"` 与 `streamingBehavior?: "steer"|"followUp"`（`types.d.ts:928-940`），idle 与 streaming 两条路都发。排除 `extension` 源（避免自激发归零）。

### 7.8 `bg_run(task_id)`：spawn 成功后再提交（R2-4）

```
1. 同步校验：R1 R4 R9 R11 + 容量准入
   失败 → isError，任务状态不变（capacity 不 park）
2. spawn（拿 pid）
   异常 → isError，任务状态不变
3. 成功后的同一同步块内：绑定 + 按需推进 in_progress + appendEntry
```

| 任务当前状态 | 第 3 步动作 |
|---|---|
| `pending` | 推进 `in_progress`（已过 R1 R4 R9） |
| `in_progress` | 只绑定（同任务多作业，§5.2 排除其互相干扰） |
| `parked`/`deferred`/`completed`/`deleted` | 第 1 步即拒 |

`error` 事件晚到（spawn 返回后才失败）→ 按 `spawn_error` 处理：链终结 + parked。
**第 3 步抛错（R3 附带意见）**：已 spawn 的子进程无人认领 ⇒ **立即 kill 它**（同同步块内），再返回 isError。
`task_id` **必填**，仅唯一 in_progress 时可省。

## 8. 面板

### 8.1 早上那一刻

```
● vigil-todo 8/12 · ⚠ 2 parked              ← 首行恒可见
├─ ✓ 8 done · all exit 0 · ⚠ 3 条 fp:?
├─ ⚠ #2 全量回归  parked
│    └─ 4 次均失败 · parser 边界条件
├─ ⚠ #3 更新文档  parked
│    └─ 公开 API 兼容需你拍板
├─ ⏸ #5 清理旧分支  deferred → bg_x7
├─ ◐ #7 补单测 (writing tests) · ✶ 2m10s · ↻ retry 2/4
└─ ○ #4 发布  ⛓ #3
```

completed 汇总一行带证据 + `⚠ N 条 fp:?` 计数（R2-11）+ `↺ reverified`（§5.2.1）+ `verify changed` 标记（R2-8）；`/todos` 逐条下钻。
parked reason 独占缩进行；deferred `⏸` + untilRoot；in_progress 带 activeForm + 耗时 + `↻ retry n/m`；deleted 依赖显示为已满足。

### 8.2 行预算

默认 12 内容行。优先级：`首行(含 ⚠N parked) > parked(含 reason) > in_progress > deferred > pending > completed汇总`。
parked 超预算 → 截断 + `+N more parked`；**首行 `⚠ N parked` 恒可见**，**`/vigil-todo` 本身能翻全量**。

### 8.3 保留的 rpiv-todo 体验

空列表自动卸载、`getToolsExpanded()` 全展开、折叠键（`ctrl+shift+t`，`off`）、`├─/└─` 与尾部空行、`#id` 仅在存在 blockedBy 时显示、i18n 降级、终端控制字符清洗。
**改掉**：completed"下一轮隐藏" → 汇总一行常驻。

### 8.4 命令

`/vigil-todo`（可翻全量 + 列"上一会话遗留"）、`/vigil-todo adopt`（一键接管遗留任务与孤儿链）、`/todos`（全量文本带 exit code + fp 下钻）、`/bg`（`k` 两次确认、Enter tail）、`/vigil-todo doctor`。

---

## 9. 两个连带修复

**9.1** `bg_run` 必须带 `task_id`（`wipLimit:3` 下自动绑失效），仅唯一 in_progress 时可省。
**9.2** job 新增 `cwd`（旧包 spawn 无 cwd 选项，`index.js:36-40`；扩展 respawn 必须用记录值）。

---

## 10. 稳定性与性能

### 10.1 必修的旧包缺陷

| 缺陷 | 位置 | 处置 |
|---|---|---|
| 恢复态伪造退出码 | `index.js:142` vs `:355→:329` | `exitCodeKnown` |
| 先记 notifiedAt 再发送 | `index.js:334-336` | `notifyState` 三段 + wakeId ack + 启动补偿 |
| 配置读 `ctx.settings`（不存在） | `index.js:806` | `pi.getSettings()` |
| 每作业一个 3s timer | `index.js:51-80` | 事件优先 + 单 timer |
| 面板 500ms 无条件 tick | `index.js:507` | 无作业时停表 |
| 每渲染读 JSON 配置 | `config.ts:37-42` | 缓存 + mtime |
| 多会话通知串台 | `index.js:759-817` | 按 sessionId 定向 |
| sidecar 非原子写 | `index.js:120-124` | tmp + rename |
| pid 复用 | 无防护 | `startStamp` 比对 |
| respawn 撞上限挂死 | `index.js:246` | 派生预留槽 + respawn 摘己准入（永不 capacity） |

### 10.2 性能预算

**timer 存在条件（R2-3 修正）**：**无 running 作业 且 无 `retryAt != null`** ⇒ 0 定时器。
否则 1 个 1s timer（面板折叠/不可见降 5s），职责：刷新耗时 + **扫 retryAt 到期 respawn** + sweep defer + **扫未 acked 超时补偿**（R5-3）。
`todo` p95 <3ms（n≤200）；replay 1 万条 <30ms；100MB 日志取 20 行 <5ms；唤醒 ≤1200 token；磁盘写 ≤1 次/变更合并 100ms；指纹每作业 2 次 git 调用。

### 10.3 降级

replay 失败 → 空列表 + notify；sidecar 读失败 → 改名留档 + 从空开始 + notify + **defer 孤儿释放**；`before_settle` 抛错 → 捕获放弃续跑；headless → UI no-op。

---

## 11. 兼容与迁移

| 项 | 方案 |
|---|---|
| 工具名 | 保留 `todo` / `bg_run` / `bg_list` / `bg_kill` |
| 快照 type | 继续写 `rpiv-todo-state`，字段超集 |
| 兼容方向 | **单向**：我们读旧 4 状态快照；旧包读不了 `parked`（其 `every(isTask)` 跳过整份快照） |
| **迁移 fallback（R2-7）** | replay 时 `inProgressSince = t.inProgressSince ?? t.statusSince ?? 0`；**`0` ⇒ R3 跳过新近度判定** ⇒ 迁移任务可被自动完成，不会只能 park |
| 迁移前置 | **必须卸载两个旧包**（P0 Q1：同名工具先注册者胜且静默；事件广播 ⇒ 半生效） |
| 启动自检 | `getAllTools()` 查 `todo` 的 `sourceInfo`，非自己 → notify **error** 且**不注册事件处理器** |
| 配置 | `~/.config/pi-kit/config.json` → `pi.getSettings().vigilTodo` → `.bgRun` → 默认 |

---

## 12. 六口径定稿

| # | 结论 |
|---|---|
| Q-A | 总尝试 **4** 次（`retries:3` = 额外次数） |
| Q-B | 指纹三态 + §5.2 两处收窄，**fpVerdict 延迟到回填时算**；非 git → unknown 标 `fp:n/a`；裁决点 = 是否叫醒人；stale 走**自动重验**而非 `expectChanges` 豁免（§5.2.1 反提案） |
| Q-C | 重试期占 WIP 位，但面板 `↻ retry n/m` + park 能取消链 |
| Q-D | 立即解除仅限根已终结或根记录不存在；后者 repair + notify |
| Q-E | 接受截断，前提首行 `⚠N parked` 恒可见且 `/vigil-todo` 能翻全量 |
| Q-F | `maxConcurrentJobs` 维持 10（已采纳并发收窄） |

---

## 13. 验收用例（F1-F105）

| # | 用例 | 期望 |
|---|---|---|
| F1 | 连续 4 次 →in_progress（limit 3） | 第 4 次 isError |
| F2 | 同批并行两个 →in_progress（limit 1） | 只一个成功 |
| F3 | 重试用尽后直接 completed | 拒，指向 lastFailure |
| F4 | 成功作业 + fp fresh | 自动 completed |
| F5 | 恢复态 | known:false → parked，不 completed |
| F6 | 空闲时作业完成 | ≤1s 起新轮，含唯一 next |
| F7 | 最后一个工具是 bg_run 就结束本轮 | 携 entry 续跑；watermark 已推进 ⇒ 同一证据不再重复投递 |
| F8 | pi 关过期间完成 | catch-up **恰一次** |
| F9 | /compact 后 list | 任务/evidence/lastFailure/park/defer/counters 全在 |
| F10 | 同 cwd 两会话各开作业 | 通知各回各家 |
| F11 | 旧包 4 状态快照 | 原样出现；**且迁移任务可被自动完成**（R2-7） |
| F12 | sidecar 损坏 | 从空 + notify + 留档 |
| F13 | 旧包未卸载 | 启动 error，不注册事件 |
| F14 | todo + 5 个 read 同批 | 仍并行 |
| F15 | verify 内跑 bash | 不被自己预检拦 |
| F16 | 失败 → 立即/30s/2min | **4 个 job id**、同 rootId、4 份日志；用尽 parked |
| F17 | kill running | 不重试，parked(killed) |
| F18 | defer untilJob，该作业失败进重试 | 单作业结束不解除；整链终结才解除 |
| F19 | #2 parked，#5 不依赖 | #5 可开工 |
| F20 | fp stale 且重验用尽 | parked，消息给 accept/verify 两条路（首次 stale 走自动重验，见 F64） |
| F21 | accept:"stale" | 放行且 accepted 留痕 |
| F22 | park 无 reason | 拒 |
| F23 | 唤醒后无动作且 next 仍在 | re-nudge 恰一次（第二格 + 新 entry）；park/defer 不触发 |
| F24 | 第 50 轮 | 硬停 + 面板标注；用户消息归零 |
| F25 | 早上面板 | 汇总行带证据 + parked reason 可见 |
| F26 | 依赖被 delete | 下游仍可推进 |
| F27 | defer untilJob 不存在 / 缺 reason | 均拒 |
| F28 | 对 deferred 直接 →in_progress | 拒 |
| F29 | 任意拒绝 | isError + details.error |
| F30 | 同一 job 绑两任务 | 拒 |
| F31 | 同一 job 重复 onExit | evidence 只一条 |
| F32 | spawn_error | 不重试，链终结，parked(spawn failed) |
| F33 | 退避窗口 bg_kill(rootId) / park | 链取消，retryAt 清空，2min 后不复活 |
| F34 | sidecar 损坏后 untilRoot 消失 | defer 释放 + repair + notify |
| F35 | 非 git 目录 | fp=unknown 标 `fp:n/a`，照常自动完成 |
| F36 | evidence 环形溢出 | lastFailure 仍在，R2 仍阻断 |
| F37 | turnsUsed 跨重启 | 保持；用户消息才归零 |
| F38 | 10 作业同时结束 | **总投递条数 = 1**（含 boundary 通道计数）（R3-1） |
| F39 | parked 施加 defer / deferred 施加 park | 均拒，给两步解法 |
| F40 | WIP 满时作业结束但无位释放 | next=null，不写开干；无新证据不唤醒 |
| F41 | bg_run 指向 pending 且 WIP 满 | 拒，不出现"绑而不推进" |
| F42 | defer 释放后重进 in_progress 复用旧 job 证据 | R3 不满足 → 需重验 |
| **F43** | 模型每轮造新 async 证据使 undelivered 反复非空 | 第 50 轮 `tryDeliver` **第一行**硬停（R2-1） |
| **F44** | 模型本轮 verify 产生证据 | `origin:tool` **不进 undelivered**，无 verify 自持环（R2-2） |
| **F45** | pi 关过一夜，retryAt 已到期 | 启动后 respawn，链能终结，defer 能释放（R2-3） |
| **F46** | 崩溃后重启 | reservedRetrySlots 由 `count(retryAt!=null)` 重算，不泄漏（R2-3） |
| **F47** | 容量不足 | 新 bg_run → isError 且任务留 pending **不 park**；**respawn 不受 capacity 影响**（R3-2）；stale 重验遇 capacity → parked(无空闲槽位重验) |
| **F48** | spawn 抛异常 | 任务**不残留 in_progress**（先 spawn 后提交）（R2-4） |
| **F49** | 人工 park 后 kill 回调晚到 | `park.reason` **不被覆盖**（R2-5） |
| **F50** | killed 之后修复并 verify | 可正常完成（killed 不写 lastFailure）（R2-5） |
| **F51** | 重进 in_progress 后用旧 verify 证据完成 | 拒（verify 也要 at >= inProgressSince）（R2-6） |
| **F52** | 迁移任务（inProgressSince=0）成功作业 | **可自动完成**（R2-7） |
| **F53** | 改 verify.command 为 `true` 再 verify | 留 manual 证据 + 标 verify changed + **禁用自动完成**（R2-8） |
| **F54** | 有 running 作业时让位 →pending | 拒，文案指向 defer（R2-9） |
| **F55** | busy 路径 steer 被消费 | 按 `message_start` + wakeId 置 acked；重启不重发（R2-10） |
| **F56** | 同 task 的 build+test 并行 | 不算干扰，fp 仍可判 fresh/stale（R2-11） |
| **F57** | 并发作业期间 fpStart===fpEnd | 不算干扰（R2-11） |
| **F58** | unknown 证据 | 自动完成 + 汇总行 `⚠N 条 fp:?` + /todos 可下钻（R2-11） |

| **F59** | 一条 async 证据到达 | **恰好 1 次投递**；busy 路径 steer 投递后 boundary 不再重复（R3-1） |
| **F60** | 10 条链同时退避（0 running / 10 reserved） | 全部 respawn 成功执行，**不出现 capacity timeout**（R3-2 自锁） |
| **F61** | boundary 通道投递 | 提交 entry 同一同步块内置 acked；重启**不补发**（R3-3） |
| **F62** | 自身有 running 作业时施加 defer | **拒**，文案指向 bg_kill 或等作业结束（R3-4） |
| **F63** | 任一 interferer 缺 fpEnd（仍在跑） | verdict = **unknown**（诚实），自动完成 + `fp:?`；**不假称已就绪**（R4-2） |
| **F64** | 独占期间自己改了代码致 stale | **自动重验一次** → fresh 则自动完成、人不被叫醒；仍 stale 才 parked（§5.2.1） |
| **F65** | 模型正在跑时用户键入纠偏 | `input` 事件归零 turnsUsed，**不会 50 轮后静默停摆**（R3-6） |
| **F66** | 模型 update 传入 jobs/evidence/lastFailure/inProgressSince/verifyChanged | 全部拒（R16 只读集合） |

| **F67** | `exit0+stale → 重验 → exit≠0 → retry → exit0+stale` | **不再产生第二次重验**（重验分支后代禁触发）；链 job 总数 ≤5（R4-1） |
| **F68** | 任务有 verify.command 时 stale 重验 | 跑 **verify.command** 而非原命令（避免重复 release/publish 副作用） |
| **F69** | stale 重验遇 capacity 拒 | **直接 parked(无空闲槽位重验)**，不静默停 in_progress |
| **F70** | 投递后久未 ack，期间发生无关轮次 | `agent_settled` 已清零 renudgeBudget ⇒ **不冒出无关 re-nudge**（R4-5） |
| **F71** | boundary entries 被 pi 丢弃 | 不置 acked、留 `sent`；catch-up 绕过 watermark 补发（R4-4） |

| **F72** | 单任务夜里作业失败 4 次用尽 | parked **且恰好一次投递**，消息带 lastFailure + 日志尾 + next（R5-1，原设计此处零唤醒） |
| **F73** | killed / spawn_error / 恢复态三种终结 | 各产生 1 条 chainFinal 证据 ⇒ 各恰好一次投递；killed 不写 lastFailure |
| **F74** | 一条链 4 次失败尝试 | 中间 3 次 `chainFinal:false` **不投递**，只有用尽那次投递 ⇒ 总投递 1 次（不是 4 次） |
| **F75** | 重叠作业仍在跑（缺 fpEnd） | 进 `overlapUnfinished` ⇒ unknown，reason="未结束，无法判定"；**不误判 stale**（R5-2） |
| **F76** | pi 整夜不重启，投递失败 | 单 timer 在 10min 后补偿送达，**不等重启**（R5-3） |

| **F77** | respawn 时 spawn 直接抛错（无 job 记录） | finalizer 合成 1 条 chainFinal（ref=rootId）⇒ **有唤醒**，不静默 park（R6-1a） |
| **F78** | 重验遇 capacity 拒（无后续 job） | 同上合成 chainFinal ⇒ 有唤醒；且 `chainTerminated` 为真 ⇒ **defer 释放**（R6-1b/R6-2） |
| **F79** | 同时存在"有写入重叠"与"未结束重叠" | verdict=**unknown**（两集合皆空才 stale），不误判 stale（R6-3） |
| **F80** | 长工具调用期间 steer 排队 >10min 未消费 | 补偿因 `ctx.isIdle()` 为假而**跳过**，不重发（R6-4） |
| **F81** | 模型自己 park 取消链 | 被 kill 作业证据 `trigger:"self"` ⇒ **不唤醒**；外部 bg_kill 仍唤醒（R6-5） |
| **F82** | 同一链重复调用 finalizeChain | 幂等，**恰好一条** chainFinal |

| **F83** | 双链任务 evidence 环形溢出后，session_start 全量 sweep | 链**仍恰一条** chainFinal（幂等读 job 侧 `finalized`），不重复投递（R7-1） |
| **F84** | 同 cwd 第二会话启动，owner 会话不在线 | B 只做链级终结（置 `finalized`），**不写 A 的 board**；A 启动后由 catch-up 投影+唤醒，恰一次（R7-1） |
| **F85** | stale 判定后崩溃（pendingReverify 已落盘、重验未 spawn） | 启动 sweep **补一次 respawn**（额度尽则判终结 parked），**链不悬置、defer 不挂死**（R7-2） |
| **F86** | 模型 park 取消链后 pi 重启 | finalize 从 sidecar 读 `kill.requestedBy="self"` ⇒ **仍不唤醒**（R7-3） |

| **F87** | 有终结 job 的链（失败用尽） | **只产出 1 条 chainFinal**（per-job 一律 false），跨 250ms 窗口也只投一次（R8-1） |
| **F88** | 早上同 cwd 开**新会话**，旧会话不再打开 | 收养 finalized && !evidenceApplied 的孤儿链 + 其绑定任务 ⇒ **证据与唤醒到位**、defer 释放；repair 日志 + notify 可见（R8-2） |
| **F89** | 中间失败 job 从不进唤醒 | 其 notifyState 不被读 ⇒ session_start/timer **不乱补**（扫描集 root 粒度）（R8-3） |
| **F90** | 两会话 sweep 同时见 pendingReverify | 原子认领，**只有一条重验 job**，命令不跑两遍（R8-4） |
| **F91** | 链 T1 被 B finalize，A 在 T2>T1 投递过别的链 | 投影 `at=now()` ≥ watermark ⇒ **仍被投递**，不被遮蔽（R8-5） |
| **F92** | 孤儿链仍在 running | **不收养**（避免两会话驱动同一进程），只列为遗留 |

| **F93** | resume 会话（board 非空）执行收养 | 导入任务**重编号** + blockedBy remap + `metadata.adoptedFrom`；多链绑同一任务先去重；无撞号（R9-1） |
| **F94** | 两会话同时通过活跃性 gate | `adoptClaim` write-reread ⇒ **只有一个收养者**，无双份任务/双唤醒（R9-2） |
| **F95** | 移交后旧会话重新打开 | 无双 owner；旧副本标 `adoptedAway` + 面板"已移交" + **冻结操作**（R9-4） |
| **F96** | 心跳文件所在会话已退出 | pid 探测失败且 heartbeat 超 15s ⇒ 判不活跃 ⇒ 可被收养；pid 复用由 startStamp 排除 |
| **F97** | 冻结的 adoptedAway 任务被模型变更 | R10 拒绝并提示去哪个会话；不会修改死副本 |

| **F98** | pi 挂死未退出（pid 活、heartbeat 停更 >10min） | 标"疑似挂死"列于 /vigil-todo；**`/vigil-todo adopt` 人工绕过 gate** + 强提示，**有出口**（R10-2） |
| **F99** | crash 后 15s 内重启 | 收养扫描并入单 timer ⇒ 15s 后心跳过期即补收养，**不整会话错过**（R10-4） |
| **F100** | 被导入任务的依赖在旧 board 已 completed 但未导入 | 对照旧快照解析 ⇒ 从 blockedBy 删除（视为已满足）+ metadata 记录；**不与 R4 组合出死锁**（R10-3） |
| **F101** | 两会话同时 O_EXCL 创建同一 claim | 恰一个成功，另一个抛错跳过 ⇒ **无双赢家**（R10-5） |
| **F102** | 文档结构自检 | 无重复章节、无 v8 旧文残留（R10-1 编辑事故） |

| **F103** | 两会话同时判同一 claim 过期 | `rename(claim → .stale.<me>)` 原子竞争 ⇒ 只有一个获重建权，**无过期路径双赢家**（R11-1） |
| **F104** | 人工 `/vigil-todo adopt` 绕过 gate 时存在 running 链 | **仍只收终态链**；running 待终结后由 timer 归入，无双头驱动（R11-2） |
| **F105** | 自身无作业的 B 会话在 A 崩溃后 15s 内启动 | `session_start` gate 失败挂**一次性 +20s 复查**（不依赖 timer）⇒ 不永不复查（R11-3） |

---

## 14. 模块划分

```
extensions/vigil-todo.ts        注册面
  ├── tool/              schema / 信封 / 渲染
  ├── board/             纯状态机 + counters（reducer/invariants/selectors）← 不 import pi
  ├── jobs/              spawn / monitor / store / kill / retry-chain / capacity
  ├── bind/              绑定对账 + defer sweep（唯一跨界写入层）
  ├── wake/              scheduler / compose / channels / watermark-quota / ack
  ├── ui/                overlay / panel / statusbar（只读）
  └── lib/               config缓存 / tail字节尾读 / atomic-write / fingerprint / log
```

---

## 15. 实施顺序

| 阶段 | 内容 | 出口 |
|---|---|---|
| P0 ✅ | 四条硬约束取证 | p0-findings.md |
| P1 | board + tool（五状态、R1-R16、统一工具面、只读集合、counters、isError、迁移 fallback） | F1 F2 F3 F9 F22 F26-F30 F36 F39 F42 F51 F52 F53 F54 F62 F66 |
| P2 | jobs（事件优先、known、cwd、原子写、pid、定向、重试链、派生槽+摘己准入、respawn 调度、链级有界 stale 重验、中止链） | F5 F10 F12 F16 F17 F31 F32 F33 F45 F46 F47 F48 F50 F60 F63 F64 F67 F68 F69 F75 F79 |
| P3 | bind + wake（回填、人工优先、**两步 finalizeChain（链级落 sidecar + owner 投影）**、派生 chainTerminated、pendingReverify 补驱动、sweep、next、四通道、投递时 watermark、turnsUsed 闸门、renudgeBudget、input 归零、指纹延迟判定、双路 ack、isIdle 守卫补偿） | F4 F6 F7 F8 F18 F19 F20 F21 F23 F24 F34 F35 F37 F38 F40 F41 F43 F44 F49 F55-F59 F61 F65 F70 F71 F72-F74 F76-F78 F80-F105 |
| P4 | ui（汇总行 + fp 计数、parked reason、deferred、retry n/m、预算、doctor） | F25 + 观感对齐 |
| P5 | 性能基准 + 迁移 + 文档 | §10.2 达标 |

---

## 16. 八方面贯穿要求（设计 / 实现 / 测试）

本节是**验收维度**，不是可选优化。每个方面都必须在三层留下痕迹：设计有条款、实现有代码、测试有断言。

| # | 方面 | 设计条款 | 实现落点 | 测试出口 |
|---|---|---|---|---|
| 1 | 性能 | §10.2 + §16.1 | `lib/config` 缓存、单 timer、字节尾读 | `tests/perf/budget.test.ts` |
| 2 | 容灾 | §5.3 / §7.1 / §7.1.1 + §16.2 | 两步 finalize、认领、心跳、补偿 | `tests/bind/*`、`tests/jobs/*` |
| 3 | 可自定义设置 | §16.3 配置契约 | `lib/config.ts` + 热更新矩阵 | `tests/lib/config.test.ts` |
| 4 | 易用性 | §6.4 / §8 + §16.4 | 拒绝文案、命令、doctor | `tests/ui/*`、`tests/tool/*` |
| 5 | 可扩展性 | §14 + §16.5 边界守卫 | 模块分层 + 公开接口清单 | `tests/arch/boundaries.test.ts` |
| 6 | 自验证能力 | §13 + §16.6 | doctor + 规格映射校验 | `tests/selfcheck/*` |
| 7 | 清理 todo | **§16.7（新）** | `board/cleanup.ts` + `clear` 扩展 | `tests/board/cleanup.test.ts` |
| 8 | 强制中断 | **§16.8（新）** | `bind/halt.ts` + 投递闸门 | `tests/bind/halt.test.ts` |

### 16.1 性能（补充约束）

- 清理与中断**不得引入新定时器**：复用既有单 timer。
- `halted` 为真且无 running 作业 ⇒ **0 定时器**（比 §10.2 更强：中断后必须彻底静默）。
- 清理 N 个任务的复杂度 O(N)，不得对每个任务单独落盘（一次 `appendEntry`）。

### 16.2 容灾（补充约束）

- `halted` 随快照落盘 ⇒ **跨重启保持**；重启后不得自动恢复推进。
- 清理必须同时处理 sidecar，否则 `finalized && !evidenceApplied` 的链会被 adopt/sweep **重新导入**（"清了又回来"）。
- 中断过程中崩溃：`halted` 已落盘但作业未全杀 ⇒ 启动 sweep 必须补杀本会话残留作业，不得留孤儿。

### 16.3 可自定义设置：配置契约

**优先级链**（已实现）：`~/.config/pi-kit/config.json` → `pi.getSettings().vigilTodo` → `.bgRun`（旧键）→ `DEFAULTS`。

**契约三件事**（缺一不可）：
1. **类型与范围**：每个键有类型、最小值；非法值**逐项退回默认**，不整体失效、不抛异常。
2. **热更新矩阵**：明确哪些键即时生效、哪些需 `/reload`。
3. **文档**：`docs/configuration.md` 列出全部键、默认值、生效时机。

| 键 | 类型 | 默认 | 生效时机 |
|---|---|---|---|
| `wipLimit` | int ≥1 | 3 | 即时（每次判定读缓存） |
| `retries` | int ≥0 | 3 | 即时（下次重试判定） |
| `retryDelaysMs` | int[] ≥0 | `[0,30000,120000]` | 即时 |
| `staleReverify` | int ≥0 | 1 | 即时 |
| `maxTurns` | int ≥1 | 50 | 即时 |
| `maxConcurrentJobs` | int ≥1 | 10 | 即时 |
| `completedTtlMs` | int ≥1 | 604800000 | 即时（下次 GC） |
| `taskRetentionMs` | int ≥0 | **0（关闭）** | 即时（下次 sweep） |
| `tailLines` / `maxTailBytes` | int ≥1 | 20 / 8192 | 即时 |
| `maxWidgetLines` | int ≥3 | 12 | 即时（下次渲染） |
| `collapseKey` | string | `ctrl+shift+t` / `off` | **需 `/reload`**（快捷键注册一次） |
| `notifyRetryMs` | int ≥1 | 600000 | 即时 |
| `heartbeatStaleMs` / `hungSuspectMs` | int ≥1 | 15000 / 600000 | 即时 |
| `wakeMergeMs` / `adoptRecheckMs` | int ≥0 / ≥1 | 250 / 20000 | 即时 |

**为什么 `taskRetentionMs` 默认 0**：自动删任务是不可逆的数据损失，默认关闭，由人显式开启。

### 16.4 易用性（补充约束）

- 清理与中断的拒绝文案必须给**下一步真实调用形态**（与 §6.4 同规格）。
- `/vigil-todo doctor` 必须报告：halted 状态、被 purge 的链数、超期未清理任务数、孤儿作业数。
- 中断是**人的动作**，必须有一条命令直达，不要求模型转述。

### 16.5 可扩展性：边界守卫（可自动化）

**稳定公开接口**（改动需同步文档与测试）：`board/types.ts` 的领域类型、`JobFacts`、`RuleContext`、`AutofillDeps`、`SweepDeps`、`AdoptDeps`、`DeliverInput`、`ToolDeps`、`VigilConfig`。

**内部实现**（可随时重构）：其余一切函数与文件布局。

**三条必须自动化断言的边界**：
1. `src/board/**` **不得** import 任何 `@earendil-works/*` 或 `extensions/`（纯状态机可独立测试）。
2. `src/jobs/**` **不得** import `src/board/*` 之外的上层（`bind/`、`wake/`、`ui/`、`tool/`）——作业子系统不懂任务编排。
3. `src/ui/**` **不得**调用任何写入口（`commit`/`put`/`save`/`appendEntry`）。

这三条用**源码扫描测试**断言，而不是靠人记住。

### 16.6 自验证能力（补充约束）

- `tests/selfcheck/spec-coverage.test.ts`：解析规格 §13 的 F 编号全集，断言**每个 F 编号都在某个测试文件的文本中出现**（用例名或注释）。缺失即失败 ⇒ 规格与测试不会静默脱节。
- `doctor` 是运行期自检，`spec-coverage` 是开发期自检，两者互补。
- 每个阶段出口必须可执行（`npm test` + `npm run typecheck`），不得以"文档写了"充当通过。

### 16.7 清理 todo（新机制）

#### 16.7.1 现状缺陷（已取证）

`clear` 当前实现为一行 `{...emptyBoard(), counters}`，运行时验证：`hasRunning=true / hasBackoff=true` 时仍返回 `op.kind="clear"` 且任务清零 ⇒ **孤儿进程 + 链悬空**。且 sidecar 未处理 ⇒ adopt/sweep 会把链**重新导入**。

#### 16.7.2 选择性清理

`clear` 不新增 action（遵守全局约束），改为接受参数：

```
todo({action:"clear"})                              // 默认 scope:"settled"
todo({action:"clear", scope:"completed"})           // 只清已完成
todo({action:"clear", scope:"deleted"})             // 只清 tombstone
todo({action:"clear", scope:"settled"})             // completed + deleted（默认）
todo({action:"clear", scope:"all", force:true})     // 全清，需 force
```

| scope | 清理对象 | 前置 |
|---|---|---|
| `completed` | `status==="completed"` | 无 |
| `deleted` | `status==="deleted"` | 无 |
| `settled`（默认） | 上两者 | 无 |
| `all` | 全部任务 | **必须 `force:true`**，且**无 running 作业、无退避链**；否则拒 |

**默认不再是"全清"**：默认 `settled` 是最小意外原则——用户说"清理"通常指清掉已完成的噪音，不是删掉正在干的活。

#### 16.7.3 孤儿防护（R18）

- `scope:"all"` 且存在 running 作业或退避链 ⇒ **拒**，文案指向 `bg_kill` 或 `/vigil-todo halt`。
- 任何 scope 下，被清任务若绑有 **running** 作业 ⇒ 该任务**跳过不清**并在结果里列出（部分成功优于静默孤儿）。
- `adoptedAway` 冻结任务：允许清理（清理是丢弃本地死副本，不是修改远端状态）⇒ R17 对 `clear` 放行，对 `update` 仍拒。

#### 16.7.4 sidecar 同步：`purged` 标记（R19）

清理任务时，其绑定链的 root 记录置 **`purged: true`**：

- `adoptableRoots` 过滤 `purged` ⇒ 不会重新导入（修 §16.7.1 的"清了又回来"）
- `catchUpScan` 过滤 `purged` ⇒ 不再补发唤醒
- `purged` 落 sidecar（与 `finalized` 同级），**不随 evidence 环形淘汰**
- 作业日志与 TTL 仍按 §10.1 回收，`purged` 不延长保留

#### 16.7.5 自动 retention

`taskRetentionMs > 0` 时，sweep 顺带清理 `completed`/`deleted` 且 `statusSince` 早于 `now - taskRetentionMs` 的任务，走与手动 `settled` **完全相同**的路径（含 `purged`）。默认 0 = 关闭。

**不清理 `parked`**：parked 是等人的决策物，自动删它等于丢掉北极星的交接物。

### 16.8 强制中断（新机制）

#### 16.8.1 语义

**中断 = 停止自主推进 + 杀掉本会话作业 + 状态留痕**，且**只能由人恢复**。

| 动作 | 谁能发起 | 效果 |
|---|---|---|
| `/vigil-todo halt` | **仅人**（命令） | 见下 |
| `/vigil-todo resume` | **仅人**（命令） | 解除 halted， counters 不重置 |
| `bg_kill({job_id})` | 人 + 模型 | 单链中止（已有） |

**模型不得 halt/resume**：`todo` 工具**不接受** halted 字段（列入 R16 只读集）。理由：若模型能 resume，它会在下一轮把自己的"停"撤销，用户的刹车失效。

#### 16.8.2 halt 的原子效果（同一同步块）

```
halt(sessionId):
  1. counters.halted = true, haltedAt = now      → 落快照（跨重启保持）
  2. 本会话所有 running 作业 → requestKill(by:"self")
     本会话所有退避链 → 清 retryAt（全局取消，不需要逐个 id）
  3. 受影响任务 → parked(reason:"用户强制中断")   ← 不写 lastFailure（不是失败）
  4. 停 timer（若无 running 作业）
```

**只杀本会话作业**（`job.sessionId === me`）：作业 sidecar 是项目共享的，halt 不得杀别的会话的活。

#### 16.8.3 复活防护（R20，最关键）

halted 为真时，**所有自主推进入口一律短路**：

| 入口 | halted 时行为 |
|---|---|
| `tryDeliver` | **第一行**返回 NONE（早于 maxTurns 判定） |
| `sweepRespawns` | 跳过，不 respawn |
| `adoptOrphans` | 跳过，不收养 |
| `catchUpScan` | 返回空 |
| `agent_before_settle` | 返回 undefined（不续跑） |
| 单 timer | 只刷新 UI，不推进 |

漏任何一个入口，用户的"停"都会在几十秒后被 sweep/timer 撤销 —— 这是本机制唯一不可接受的失败模式。

#### 16.8.4 与 pi 的 abort 的关系

pi 的 Esc/`ctx.abort()` 只中断**当前模型轮次**，不影响 detached 作业。本扩展**不挂钩 abort**：Esc 不等于 halt（用户可能只想停这一轮回答，不想杀训练）。两者语义分离，文档必须写明。

#### 16.8.5 崩溃与幂等

- halt 重复调用幂等（已 halted 则只补杀残留作业）。
- halt 落盘后崩溃 ⇒ 启动 sweep 见 `halted && 本会话仍有 running` ⇒ **补杀**，不留孤儿。
- resume 后 `turnsUsed` **不重置**（避免用 halt/resume 绕过 maxTurns 保险丝）；只有用户 input 才归零。

---

## 17. 范围收缩决议（用户 2026-11-22 显式撤回决策 13）

### 17.1 用户原话与推导

> 「不会有跨会话的 todo 执行，因此并发 todo 没有意义」
> 「不会新开会话，还是用的老会话」

由此确定运行模型：

```
单会话 · resume 复用 · 模型串行专注一个 todo · 该 todo 下可挂多个并行作业
```

**关键区分（此前设计混淆过）**：后台并行跑的是**命令**，不是**todo**。推进 todo 需要模型判断（证据够不够、要不要 park、下一步是谁），shell 进程没有这个判断力。所以「多 todo 并发推进」是伪需求；「一个 todo 下多作业并行」是真需求，收益全部保留。

### 17.2 撤回与删除清单

| 项 | 处置 | 依据 |
|---|---|---|
| 决策 13 的 `wipLimit: 3` | **改为 `wipLimit: 1`** | 模型物理串行，>1 只带来面板噪音与白堵位 |
| 决策 13 的 `defer(untilJob)` | **整套删除** | WIP=1 已串行化任务，「B 等 A 的作业」场景不存在 |
| §4.3 defer 语义 / §4.4 互斥 / §4.5 defer sweep | **废** | 同上 |
| §7.1.1 孤儿链收养 A–F 全节 | **废** | 永不新开会话 ⇒ replay 足够 |
| `src/jobs/claims.ts`（O_EXCL 认领 + rename 收回） | **删** | 无竞争者 |
| `src/jobs/heartbeat.ts`（会话心跳判活） | **删** | 同时只有一个会话 |
| `src/bind/adopt.ts`（收养/重编号/冻结） | **删** | 无接续新会话 |
| R17 `adoptedAway` 冻结 | **删** | 无移交 |
| R13 park/defer 互斥 | **删** | defer 不存在 |
| §5.2 两集合收窄（`interferers` / `overlapUnfinished`） | **合并为单一 `interferers`** | 同任务排除后跨任务干扰不存在；缺 `fpEnd` 归 unknown 即可 |
| 规则编号 R13/R17/R19(purged 防收养部分) | 见 §17.4 保留说明 | |

**受影响验收用例**：F18 F27 F28 F34 F39 F62 F78（defer）、F88 F92 F93 F94 F95 F97 F98 F100 F104 F105（收养/心跳）、F90 F101 F103（认领）、F56 F57 F63 F75 F79（两集合）⇒ **删除或重写**，不得留下引用已废机制的测试。

### 17.3 必须保留（与并发无关，删了会破北极星）

| 项 | 为什么仍需要 |
|---|---|
| **一个 todo 挂多作业 + `maxConcurrentJobs: 10`** | 真并行收益全在这里（训练/回归/lint 同时跑） |
| **指纹 stale + 自动重验** | 模型在**自己**的测试作业期间改代码照样失真，与跨会话无关 |
| `recoverJobs` + `exitCodeKnown:false` | pi 关过再 resume，detached 作业可能已死或仍在跑，退出码不能猜 |
| **running 作业排除** | resume 时昨晚遗留作业可能仍在跑，不得重复 spawn |
| 两步 finalize（sidecar 权威 + 投影幂等） | pi 关着时作业结束无人记录；resume 后靠 `finalized`/`evidenceApplied` 幂等投影 |
| `notifyState` + catch-up 补偿 | pi 关着期间完成 ⇒ resume 补发恰一次 |
| 重试链有界性、`turnsUsed` 保险丝、唤醒单次性 | 与并发无关 |
| halt/resume、选择性清理、`purged` | 与并发无关；`purged` 仍防**清理后 catch-up 补发** |
| 配置契约、边界守卫、规格↔测试自检 | 八方面要求不变 |

### 17.4 收缩后的规则集

R1（WIP=1）、R2、R3、R4、R5、R6、R7（park 必带 reason）、R8 **废**（defer）、R9 简化（只有 park，无 defer）、R10、R11、R12、R13 **废**、R14 简化（让位仍要求无 running/退避链）、R15、R16（只读集去掉 defer 相关、加 halted）、R17 **废**、R18（清理孤儿防护）、R19（purged，仅防 catch-up）、R20（halt 复活防护，入口从五处减为四处：`tryDeliver`/`sweepRespawns`/`catchUpScan`/`before_settle`，adopt 已删）。

### 17.5 新增不变量（防止已废机制回潮）

`tests/arch/scope.test.ts` 必须断言：`src/` 与 `extensions/` 中**不出现** `defer`、`adopt`、`heartbeat`、`claims`、`adoptedAway` 这些标识符（`docs/` 与本决议除外）。删除是决议，不是临时注释掉。

### 17.6 顺带修正（保留一行防御）

`classifyOverlap` 的排除条件由 `a.taskId !== b.taskId` 改为 **`a.taskId !== b.taskId || a.sessionId !== b.sessionId`**（同 task **且同 session** 才排除）。当前范围下不会触发，但成本一行，防止范围再变时静默误判。已取证：改前跨会话同 taskId 的写入作业被误排除，`interferers: []`、`verdict: stale`（应为 unknown）。
