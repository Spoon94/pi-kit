# 八方面质量矩阵（规格 §16）

每个方面必须在三层留下痕迹：设计有条款、实现有代码、测试有断言。表中路径均为仓库内真实文件；用例数为该文件在当前测试集中的 `it`/`it.each` 展开数（由 `npm test` 核对）。

| 方面 | 设计条款 | 实现文件 | 测试文件（用例数） |
|---|---|---|---|
| 性能 | §10.2、§16.1 | `src/lib/config.ts`（mtime 缓存）、`src/lib/tail.ts`（字节尾读）、`src/jobs/monitor.ts`（事件优先 + 单 timer 条件） | `tests/perf/budget.test.ts`（3） |
| 容灾 | §5.3、§7.1、§16.2 | `src/bind/finalize.ts`（两步 finalize）、`src/bind/sweep.ts`（补驱动/补偿/retention）、`src/jobs/store.ts`（原子写/留档/GC）、`src/jobs/monitor.ts`（recoverJobs） | `tests/bind/finalize.test.ts`（8）、`tests/bind/sweep.test.ts`（13）、`tests/jobs/store.test.ts`（5）、`tests/jobs/monitor.test.ts`（2） |
| 可自定义设置 | §16.3 | `src/lib/config.ts`（`DEFAULTS` + `CONFIG_KEYS` + 逐键校验）、`docs/configuration.md` | `tests/lib/config.test.ts`（9） |
| 易用性 | §6.4、§8、§16.4 | `src/ui/panel.ts`（面板/`/todos`/doctor）、`src/wake/compose.ts`（真实调用形态）、`extensions/vigil-todo.ts`（命令与拒绝文案） | `tests/ui/panel.test.ts`（8）、`tests/wake/compose.test.ts`（4）、`tests/tool/register.test.ts`（7） |
| 可扩展性 | §14、§16.5、§17.5 | `src/board/types.ts`、`src/board/invariants.ts`（`JobFacts`/`RuleContext`）、`src/bind/{autofill,sweep,finalize,halt}.ts`、`src/wake/deliver.ts`、`src/tool/register.ts`（`ToolDeps`） | `tests/arch/boundaries.test.ts`（3）、`tests/arch/scope.test.ts`（3） |
| 自验证能力 | §13、§16.6 | `src/ui/panel.ts`（`renderDoctor`）、`extensions/vigil-todo.ts`（doctor 汇总 purged/超期/孤儿） | `tests/selfcheck/spec-coverage.test.ts`（3）、`tests/ui/panel.test.ts`（8） |
| 清理 todo | §16.7 | `src/board/cleanup.ts`（选择性 clear / `purged` / retention）、`src/tool/register.ts`（clear 接线）、`src/bind/sweep.ts`（catch-up 过滤 + retention） | `tests/board/cleanup.test.ts`（12） |
| 强制中断 | §16.8 | `src/bind/halt.ts`（halt/resume/reap）、`src/wake/deliver.ts`（首行闸门）、`src/bind/sweep.ts`（两处短路）、`extensions/vigil-todo.ts`（命令 + before_settle + timer/init 短路） | `tests/bind/halt.test.ts`（11） |
| 依赖环与死锁可见性 | §18（R21） | `src/board/graph.ts`（DFS 三色找环）、`src/board/reducer.ts`（create/addBlockedBy 接入）、`src/ui/panel.ts`（doctor 环与「无可推进」、面板首行标记） | `tests/board/cycle.test.ts`（7） |

## 边界守卫（§16.5 / §17.5）

`tests/arch/boundaries.test.ts` 扫描源码并断言：

1. `src/board/**` 不 import `@earendil-works/*` 或 `extensions/`；
2. `src/jobs/**` 不 import `bind/`、`wake/`、`ui/`、`tool/`；
3. `src/ui/**` 不调用 `commit` / `put` / `save` / `appendEntry`。

`tests/arch/scope.test.ts` 断言已废机制不回潮：`src/` 与 `extensions/` 中不出现 defer / adopt / heartbeat / claims / adoptedAway，且三个已废模块文件确实不存在。

## 规格↔测试映射（§16.6）

`tests/selfcheck/spec-coverage.test.ts` 解析规格 §13 的全部 F 编号（≥105），排除 §17.2 范围收缩已废的编号后，断言每个编号都出现在 `tests/**` 的文本中；缺失即失败。F102（文档结构自检）本身以顶层章节去重断言实现。
