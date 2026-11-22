# 八方面质量矩阵（规格 §16）

每个方面必须在三层留下痕迹：设计有条款、实现有代码、测试有断言。表中路径均为仓库内真实文件；用例数为该文件在当前测试集中的 `it`/`it.each` 展开数（由 `npm test` 核对）。

| 方面 | 设计条款 | 实现文件 | 测试文件（用例数） |
|---|---|---|---|
| 性能 | §10.2、§16.1 | `src/lib/config.ts`（mtime 缓存）、`src/lib/tail.ts`（字节尾读）、`src/jobs/monitor.ts`（事件优先 + 单 timer 条件） | `tests/perf/budget.test.ts`（3） |
| 容灾 | §5.3、§7.1、§16.2 | `src/bind/finalize.ts`（两步 finalize）、`src/bind/sweep.ts`（补驱动/补偿/retention）、`src/jobs/store.ts`（原子写/留档/GC/路径校验）、`src/jobs/monitor.ts`（recoverJobs） | `tests/bind/finalize.test.ts`（11）、`tests/bind/sweep.test.ts`（15）、`tests/jobs/store.test.ts`（7）、`tests/jobs/monitor.test.ts`（5） |
| 可自定义设置 | §16.3 | `src/lib/config.ts`（`DEFAULTS` + `CONFIG_KEYS` 含 min/max + 逐键校验）、`docs/configuration.md` | `tests/lib/config.test.ts`（14） |
| 易用性 | §6.4、§8、§16.4 | `src/ui/panel.ts`（面板/`/todos`/doctor）、`src/wake/compose.ts`（真实调用形态 + 耗时）、`extensions/vigil-todo.ts`（命令与拒绝文案） | `tests/ui/panel.test.ts`（12）、`tests/wake/compose.test.ts`（7）、`tests/tool/register.test.ts`（10） |
| 可扩展性 | §14、§16.5、§17.5 | `src/board/types.ts`、`src/board/invariants.ts`（`JobFacts`/`RuleContext`）、`src/bind/{autofill,sweep,finalize,halt}.ts`、`src/wake/deliver.ts`、`src/tool/register.ts`（`ToolDeps`） | `tests/arch/boundaries.test.ts`（3）、`tests/arch/scope.test.ts`（3） |
| 自验证能力 | §13、§16.6、§18.4 | `src/ui/panel.ts`（`renderDoctor`）、`extensions/vigil-todo.ts`（doctor 汇总 purged/超期/孤儿/环） | `tests/selfcheck/spec-coverage.test.ts`（5）、`tests/selfcheck/config-consumed.test.ts`（2）、`tests/ui/panel.test.ts`（12） |
| 清理 todo | §16.7 | `src/board/cleanup.ts`（选择性 clear / `purged` / retention）、`src/tool/register.ts`（clear 接线）、`src/bind/sweep.ts`（catch-up 过滤 + retention） | `tests/board/cleanup.test.ts`（16） |
| 强制中断 | §16.8 | `src/bind/halt.ts`（halt/resume/reap）、`src/wake/deliver.ts`（首行闸门）、`src/bind/sweep.ts`（两处短路）、`extensions/vigil-todo.ts`（命令 + before_settle + timer/init 短路） | `tests/bind/halt.test.ts`（12） |
| 依赖环与死锁可见性 | §18（R21） | `src/board/graph.ts`（DFS 三色找环）、`src/board/reducer.ts`（create/addBlockedBy 接入）、`src/ui/panel.ts`（doctor 环与「无可推进」、面板首行标记） | `tests/board/cycle.test.ts`（7） |
| 输出清洗与终端安全 | §6.4、§8（终端安全） | `src/lib/sanitize.ts`（含 `sanitizeMultiline`）、`src/ui/panel.ts`、`src/wake/compose.ts`、`src/tool/envelope.ts`、`src/tool/register.ts`、`src/bind/autofill.ts`、`extensions/vigil-todo.ts`（`/bg` 与 notify） | `tests/security/output-sanitize.test.ts`（11）、`tests/integration/extension-entry.test.ts`（命令清洗 1） |
| logPath 路径穿越防护 | §10.1（sidecar 安全） | `src/jobs/store.ts`（`relative` + `realpath` containment）、`src/wake/compose.ts`、`src/bind/autofill.ts`、`extensions/vigil-todo.ts`（`/bg tail`） | `tests/jobs/store.test.ts`（2）、`tests/wake/compose.test.ts`（1）、`tests/bind/autofill.test.ts`（1）、`tests/integration/extension-entry.test.ts`（1） |
| 进度可信（allExit0/证据滚动） | §8.1 | `src/board/selectors.ts`（`evidenceRolled`）、`src/ui/panel.ts`（汇总行） | `tests/board/selectors.test.ts`（1）、`tests/ui/panel.test.ts`（1） |
| WIP 超卖可见性 | §8.1 | `src/ui/panel.ts`（面板首行 + doctor） | `tests/ui/panel.test.ts`（1） |
| 功能完备性与模型指引 | §19.1、§19.2、§19.3 | `src/tool/guidance.ts`（默认 per-tool snippets + 配置覆盖）、`src/tool/schema.ts`（每个参数 description）、`src/tool/envelope.ts`（list includeDeleted/status、get 详情）、`src/ui/panel.ts`（truncateToWidth）、`extensions/vigil-todo.ts`（session_start 按配置重注册工具指引） | `tests/tool/guidance.test.ts`（5）、`tests/tool/envelope.test.ts`（7）、`tests/ui/panel.test.ts`（14）、`tests/integration/extension-entry.test.ts`（guidance/killed note 等）、`tests/board/edge-cases.test.ts`（9）、`tests/tool/edge-cases.test.ts`（3） |

## 覆盖率基线与门禁（§19.5）

- 测量命令：`npm run coverage`（v8 provider；排除纯类型文件 `src/jobs/types.ts`）
- 门禁命令：`npm run coverage:check`，阈值 **行 ≥95% / 分支 ≥90% / 函数 ≥95%**，未达即非零退出
- 本轮基线（2026-11-22）：**行 98.97% / 分支 92.87% / 函数 98.63%**
- 交付前必跑：`npm test && npm run typecheck && npm run coverage:check`，或一次运行 `npm run verify`
- perf 稳定性：`fileParallelism:false`（文件串行，避免 perf 与其他测试争 CPU）+ JIT 预热丢弃前两批 + 5 批 p95 取中位数；4 个 CPU burner 负载下连续 5 次全量套件全部通过
- 门禁实测：正常全量通过；临时移除大量测试后覆盖率下降（本次实验 98.92→97.33 行、92.13→91.71 分支），把阈值人为提高即出现 `ERROR: Coverage for ... does not meet ...` 非零退出；删除 tool/ui 测试会使 `coverage:check` 因自检/阈值一起失败。

## 边界守卫（§16.5 / §17.5）

`tests/arch/boundaries.test.ts` 扫描源码并断言：

1. `src/board/**` 不 import `@earendil-works/*` 或 `extensions/`；
2. `src/jobs/**` 不 import `bind/`、`wake/`、`ui/`、`tool/`；
3. `src/ui/**` 不调用 `commit` / `put` / `save` / `appendEntry`。

`tests/arch/scope.test.ts` 断言已废机制不回潮：`src/` 与 `extensions/` 中不出现 defer / adopt / heartbeat / claims / adoptedAway，且三个已废模块文件确实不存在。

## 规格↔测试映射（§16.6）

`tests/selfcheck/spec-coverage.test.ts` 解析规格 §13 的全部 F 编号（≥105），排除 §17.2 范围收缩已废的编号后，断言每个编号都出现在 `tests/**` 的文本中；缺失即失败。F102（文档结构自检）本身以顶层章节去重断言实现。
