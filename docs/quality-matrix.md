# 八方面质量矩阵（规格 §16）

每个方面必须在三层留下痕迹：设计有条款、实现有代码、测试有断言。表中路径均为仓库内真实文件。

**用例数口径**：括号内是**该方面相关的用例数**（同一个测试文件可能服务多个方面，所以跳行相加会大于文件全集）。文件全集与总数以 `npm test` 实跑为准；覆盖率以 `npm run coverage:check` 为准。

| 方面 | 设计条款 | 实现文件 | 测试文件（用例数） |
|---|---|---|---|
| 性能 | §10.2、§16.1 | `src/lib/config.ts`（mtime 缓存）、`src/lib/tail.ts`（字节尾读）、`src/jobs/monitor.ts`（事件优先 + 终态即释放 + 单 timer 条件）、`src/jobs/coalesce.ts`（同步批次合并写）、`src/jobs/store.ts`（终态记录上限）、`src/bind/sweep.ts`（空闲零落盘 + 重验集合一次扫描）、`src/bind/finalize.ts`（同 tick 合并落盘）、`src/board/cleanup.ts`（幂等守卫）、`extensions/vigil-todo.ts`（同批指纹缓存 + 单快照） | `tests/perf/budget.test.ts`（3）、`tests/perf/scale.test.ts`（1）、`tests/perf/burst.test.ts`（1）、`tests/perf/soak.test.ts`（3） |
| 容灾 | §5.3、§7.1、§16.2 | `src/bind/finalize.ts`（两步 finalize）、`src/bind/sweep.ts`（补驱动/补偿/retention + `boardDirty`）、`src/jobs/store.ts`（原子写/留档/GC/上限/路径校验）、`src/jobs/monitor.ts`（recoverJobs + 恢复退出补走 onJobExit）、`src/wake/deliver.ts`（root 状态权威） | `tests/bind/finalize.test.ts`（12）、`tests/bind/sweep.test.ts`（23）、`tests/jobs/store.test.ts`（9）、`tests/jobs/monitor.test.ts`（7）、`tests/wake/deliver.test.ts`（A3 2） |
| 可自定义设置 | §16.3 | `src/lib/config.ts`（`DEFAULTS` + `CONFIG_KEYS` 含 min/max + 逐键校验 + `haltKey`）、`docs/configuration.md` | `tests/lib/config.test.ts`（16）、`tests/selfcheck/config-consumed.test.ts`（2） |
| 易用性 | §6.4、§8、§16.4、§20 | `src/ui/panel.ts`（面板/`/todos`/doctor/状态栏）、`src/ui/completions.ts`（子命令 / `clear` 范围 / 动态 job id 补全）、`src/wake/compose.ts`（真实调用形态 + 耗时）、`extensions/vigil-todo.ts`（`/vt` 别名、`/vt clear` 两步确认、快捷提示、halt 快捷键、命令文案） | `tests/ui/panel.test.ts`（16）、`tests/ui/completions.test.ts`（7）、`tests/wake/compose.test.ts`（7）、`tests/tool/register.test.ts`（10）、`tests/integration/extension-entry.test.ts`（T1–T3/C1–C4/F123–F132） |
| 可扩展性 | §14、§16.5、§17.5 | `src/board/types.ts`、`src/board/invariants.ts`（`JobFacts`/`RuleContext`）、`src/bind/{autofill,sweep,finalize,halt}.ts`、`src/wake/deliver.ts`、`src/tool/register.ts`（`ToolDeps`） | `tests/arch/boundaries.test.ts`（3）、`tests/arch/scope.test.ts`（3） |
| 自验证能力 | §13、§16.6、§18.4 | `src/ui/panel.ts`（`renderDoctor`）、`extensions/vigil-todo.ts`（doctor 汇总 purged/超期/孤儿/环） | `tests/selfcheck/spec-coverage.test.ts`（5）、`tests/selfcheck/config-consumed.test.ts`（2）、`tests/ui/panel.test.ts`（16） |
| 清理 todo | §16.7、§20 | `src/board/cleanup.ts`（选择性 clear / `purged` / retention）、`src/tool/register.ts`（clear 接线）、`extensions/vigil-todo.ts`（`/vt clear` 复用同一套 plan/apply/markPurged）、`src/bind/sweep.ts`（catch-up 过滤 + retention） | `tests/board/cleanup.test.ts`（17）、`tests/integration/extension-entry.test.ts`（F123–F130/F132） |
| 强制中断 | §16.8 | `src/bind/halt.ts`（halt/resume/reap）、`src/wake/deliver.ts`（首行闸门）、`src/bind/sweep.ts`（两处短路）、`extensions/vigil-todo.ts`（命令 + `haltKey` 快捷键 + before_settle + timer/init 短路） | `tests/bind/halt.test.ts`（12）、`tests/integration/extension-entry.test.ts`（halt 快捷键/进程消失） |
| 依赖环与死锁可见性 | §18（R21） | `src/board/graph.ts`（DFS 三色找环）、`src/board/reducer.ts`（create/addBlockedBy 接入）、`src/ui/panel.ts`（doctor 环与「无可推进」、面板首行标记） | `tests/board/cycle.test.ts`（7） |
| 输出清洗与终端安全 | §6.4、§8（终端安全） | `src/lib/sanitize.ts`（含 `sanitizeMultiline`）、`src/ui/panel.ts`、`src/wake/compose.ts`、`src/tool/envelope.ts`、`src/tool/register.ts`、`src/bind/autofill.ts`、`extensions/vigil-todo.ts`（`/bg` 与 notify） | `tests/security/output-sanitize.test.ts`（11）、`tests/integration/extension-entry.test.ts`（命令清洗 1） |
| logPath 路径穿越防护 | §10.1（sidecar 安全） | `src/jobs/store.ts`（`relative` + `realpath` containment）、`src/wake/compose.ts`、`src/bind/autofill.ts`、`extensions/vigil-todo.ts`（`/bg tail`） | `tests/jobs/store.test.ts`（2）、`tests/wake/compose.test.ts`（1）、`tests/bind/autofill.test.ts`（1）、`tests/integration/extension-entry.test.ts`（1） |
| 进度可信（allExit0/证据滚动） | §8.1 | `src/board/selectors.ts`（`evidenceRolled`）、`src/ui/panel.ts`（汇总行） | `tests/board/selectors.test.ts`（1）、`tests/ui/panel.test.ts`（1） |
| WIP 超卖可见性 | §8.1 | `src/ui/panel.ts`（面板首行 + doctor） | `tests/ui/panel.test.ts`（1） |
| 功能完备性与模型指引 | §19.1、§19.2、§19.3 | `src/tool/guidance.ts`（默认 per-tool snippets + 触发意图 + 配置覆盖）、`src/tool/schema.ts`（每个参数 description）、`src/tool/envelope.ts`（list includeDeleted/status、get 详情）、`src/ui/panel.ts`（truncateToWidth / 状态栏）、`extensions/vigil-todo.ts`（session_start 按配置重注册工具指引 + C1–C6 命令面） | `tests/tool/guidance.test.ts`（5）、`tests/tool/envelope.test.ts`（7）、`tests/ui/panel.test.ts`（16）、`tests/integration/extension-entry.test.ts`（guidance/killed note/`/vt`/状态栏等）、`tests/board/edge-cases.test.ts`（9）、`tests/tool/edge-cases.test.ts`（3） |

## 覆盖率基线与门禁（§19.5）

- 测量命令：`npm run coverage`（v8 provider；排除纯类型文件 `src/jobs/types.ts`）
- 门禁命令：`npm run coverage:check`，阈值 **行 ≥95% / 分支 ≥90% / 函数 ≥95%**，未达即非零退出
- 本轮基线（2026-11-22）：**行 99.49% / 分支 93.66% / 函数 98.81%**（439 用例）
- 交付前必跑：`npm test && npm run typecheck && npm run coverage:check`，或一次运行 `npm run verify`
- perf 稳定性：`fileParallelism:false`（文件串行，避免 perf 与其他测试争 CPU）+ JIT 预热丢弃前两批 + 5 批 p95 取中位数；4 个 CPU burner 负载下连续 5 次全量套件全部通过
- 门禁实测：正常全量通过；临时移除大量测试后覆盖率下降（本次实验 98.92→97.33 行、92.13→91.71 分支），把阈值人为提高即出现 `ERROR: Coverage for ... does not meet ...` 非零退出；删除 tool/ui 测试会使 `coverage:check` 因自检/阈值一起失败。

## 性能基线（§10.2，2026-11-22）

`sweepAll`（1s tick 路径）在无变更时不再重写 sidecar：`sweepRespawns` 用脏标记，仅在实际 put/delete 后 `save()`；`finalizeAndProject` 把 finalize 与 project 合并为一次落盘；`markPurged` 幂等跳过已清理记录；`recoverJobs` 返回改动条数，调用方据此决定是否落盘。另修掉逐 job 全表扫描 `staleReverifyOf` 的 O(n²) 热点，改为一次扫描建 root 集合。

- 测量命令：`npx vitest run tests/perf/scale.test.ts`（JIT 预热 20 次，采样 50 次；与 piper 的临时脚本同负载、同口径）
- 表中优化后数值取自与优化前同脚本的一次运行；重复测量有 ±0.03ms 抖动。该用例断言中位数 < 1ms 并同时打印均值/中位数，防止无条件落盘回归。

| 规模（任务/作业） | 优化前 | 优化后 | 倍数 |
|---|---|---|---|
| 50 / 20 | 23.10 ms | 0.008 ms | ~2900× |
| 200 / 100 | 25.61 ms | 0.034 ms | ~750× |
| 200 / 300 | 24.06 ms | 0.050 ms | ~480× |

落盘次数由回归用例固定：空闲 `sweepAll` 为 0 次（`tests/bind/sweep.test.ts`）；到期 respawn 成功/失败、清除悬置 `pendingReverify`、`finalizeAndProject`、`markPurged` 的真实变更各恰好 1 次（`tests/bind/sweep.test.ts`、`tests/bind/finalize.test.ts`、`tests/board/cleanup.test.ts`）。

### 完整空转 tick 成本（piper 独立测量，含 gc + sweep + 渲染 + needsTimer）

上表只比 `sweepAll` 单组件；下表是 **整个 tick 路径的合计**，包括之前未单独量过的 `jobs.gc`（每 tick 扫全表）：

| 规模（任务/作业） | gc | sweepAll | renderPanel | needsTimer | **完整 tick** |
|---|---|---|---|---|---|
| 50 / 20 | 0.0014 | 0.0069 | 0.0330 | 0.0013 | **0.0426 ms** |
| 200 / 100 | 0.0038 | 0.0173 | 0.0744 | 0.0029 | **0.0984 ms** |
| 200 / 300 | 0.0037 | 0.0294 | 0.0450 | 0.0092 | **0.0874 ms** |
| 200 / **2000**（终态上限） | 0.0180 | 0.1111 | 0.0638 | 0.0556 | **0.2485 ms** |

单位 ms。优化前**仅 `sweepAll` 一项**就 22.8 ms；现在即使 2000 作业极端规模，**整个 tick** 也只 0.2485 ms（约 92×）。按 1s tick 间隔换算，CPU 占用 **≤0.025%**，无尖刺。

### 内存与句柄（真实 GC soak，piper 独立复测）

| 区间 | 优化前 heap 增长 | 优化后 |
|---|---|---|
| 50 → 350 周期 | +0.67 MB | **+0.10 MB** |
| 350 → 650 周期 | +0.63 MB | **+0.06 MB** |

句柄数全程稳定 3，clearAll 后 heap 回落。根因是 `monitor.fired` Set 只增不减（~2.2KB/周期），已改为终态即释放三表登记，late duplicate 因登记已删而自然忽略（F31 语义不变）。

## 稳定性与触发方式（2026-11-22）

### A. 丢状态修复
- **A1 park 不落分支快照**：`sweepAll` 返回 `boardDirty`（`parkTask` / `projectFinal` / retention 都会置位）；扩展的 `runSweep` 改为按 board 对象身份比较，有未落快照的变化才 `appendEntry`。磁盘级回归：`tests/integration/extension-entry.test.ts` 的「A1 … 重放读回 parked」用 `replayBranch` 读回快照，并断言 sidecar 的 `retryAt` 已清。
- **A2 恢复退出漏走 onJobExit**：原 `onJobExit` 本来就在 `put` 后无条件 `save`；真正漏的是 `recoverJobs` 把已消失的 running 标 failed 后不再走退出路径（fpEnd / autofill / finalize 全跳过）。现在 `initSession` 记录加载前的 running 集合，恢复为 failed 的逐条补走 `onJobExit`；`fpStart` 缺失时不再白跑 git。回归测试读回 sidecar 的 `fpEnd`。
- **A3 时钟回拨**：`tryDeliver` 的未投递判定改以 sidecar 的 `root.notifyState` 为权威，watermark 只作未知 ref 的保守过滤。回归：watermark=5000、证据 at=500 仍投递；未知 ref 仍被 watermark 挡住。

### B. 稳定性数据（同机实测）
- **B1 monitor 无界增长**：`emit` 终结即删除 `jobs` / `handlers` / `stops` 三张表的 per-job 条目，不再保留只增不减的 `fired` Set；late duplicate 由「记录已不存在」直接忽略，F31 语义不变。soak（`tests/perf/soak.test.ts`，真实 `--expose-gc`）：5000 周期后 heap 增长 **-0.2 ~ -0.5 KiB**（修复前 ~2.2 KB/周期），句柄 **2→2**，定时器 **0**。
- **B2 突发写放大**：`src/jobs/coalesce.ts` 把同一同步批次内的 `save()` 合并为一次同步写（批次外保持原有同步落盘）；扩展用 `batch()` 包住 tick / onJobExit / initSession / 命令处理，真实子进程的 close 回调先入队，在 `setImmediate` 的 check 阶段（同一事件循环 turn，非定时器）统一处理并合并落盘；换 store 与 shutdown 前强制 flush。10 作业同一同步批次终结（`tests/perf/burst.test.ts`）：

| 指标 | 优化前（check 实测） | 优化后 |
|---|---|---|
| 耗时 | 223.7 ms | **76–93 ms**（典型 ~78 ms） |
| sidecar 写 | 10 | **1** |
| board 快照 | 20 commit | **2**（10 任务合并 1 张状态快照 + 1 张投递计数） |

  剩余成本已接近 durability 下限：~21–22 ms fsync 一次 + ~50 ms 一次 git 指纹（10 个同 cwd 作业只采一次，`fpCache` 只存活于同步批次内）。同一 turn 的多个退出才合并；真实进程若分落在不同 turn，按 turn 各落盘一次（这是 durability 要求，不跨 turn 使用定时器）。命令：`npx vitest run tests/perf/burst.test.ts`。
- **B3 资源与孤儿**：真实进程周期 p50 **6.8–7.4 ms**、p95 **8.8–11.8 ms**、max **9.8–25.1 ms**（fork/exec 抖动，`tests/perf/soak.test.ts`）。`halt` 后真实子进程退出（现有 escalate 测试）；`session_shutdown` **按设计不杀作业**（跨重启继续，见 migration），但回归用例验证进程仍被 sidecar 的 pid+startStamp 完整跟踪，下一实例可 `/vt halt` 到进程消失——不存在“无人跟踪”的孤儿。spawn 后登记失败（异常路径）由 `trackSpawned` 统一 `abandon`：移出 spawn 表并 SIGKILL 进程组，单测注入抛错验证；`killNow` 真杀进程组另有测试。
- **B4 jobs 记录上限**：单条约 **713 B**；仅靠 7 天 TTL，10 并发 × 每分钟 1 个作业 ≈ **100,800 条 ≈ 69 MB**，每次重写都会放大。`gc` 增加 `MAX_JOB_RECORDS = 2000`（≈1.4 MB）硬上限：只回收「root 已 finalized + evidenceApplied + acked/self」的完整链，按最旧优先；running / retryAt / 未投影 / 未 ack 一律保留（`tests/jobs/store.test.ts`）。

### C. 触发方式
- **C1** 新增 `/vt`，与 `/vigil-todo` 共用 handler，支持 halt/resume/doctor；原命令保留。
- **C2** 状态栏：`renderStatus` 输出 `● N jobs` / `⚠ N parked` / `⏸ halted` / `✓ done/total`，空态传 `undefined` 清空；刷新只挂在既有 `refreshOverlay`/tick，不新增定时器。
- **C3** 无参数 `/vigil-todo`、`/vt` 末尾追加一行 `halt 停 · resume 继续 · doctor 自检 · /todos 全量 · /bg 作业`。
- **C4** 新增 `haltKey`（默认 `alt+h`，`off` 关闭；需 `/reload`），进入 `CONFIG_KEYS`、`docs/configuration.md`、config-consumed 自检；快捷键真实中断并落快照。
- **C5** 默认指引增加触发意图：用户说去睡 / 跑一晚 / 批量 / 后台跑时主动建 todo + `bg_run`，并告知 `/vt halt` 刹车。
- **C6** `/vigil-todo`、`/vt`、`/todos`、`/bg` 的 description 写清触发方式与常用子命令。

## 边界守卫（§16.5 / §17.5）

`tests/arch/boundaries.test.ts` 扫描源码并断言：

1. `src/board/**` 不 import `@earendil-works/*` 或 `extensions/`；
2. `src/jobs/**` 不 import `bind/`、`wake/`、`ui/`、`tool/`；
3. `src/ui/**` 不调用 `commit` / `put` / `save` / `appendEntry`。

`tests/arch/scope.test.ts` 断言已废机制不回潮：`src/` 与 `extensions/` 中不出现 defer / adopt / heartbeat / claims / adoptedAway，且三个已废模块文件确实不存在。

## 规格↔测试映射（§16.6）

`tests/selfcheck/spec-coverage.test.ts` 解析规格 §13 的全部 F 编号（≥105），排除 §17.2 范围收缩已废的编号后，断言每个编号都出现在 `tests/**` 的文本中；缺失即失败。F102（文档结构自检）本身以顶层章节去重断言实现。
