# vigil-todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `pi-kit` 中实现 `vigil-todo` 扩展，把任务计划与后台作业合成一条闭环：作业结束自动回填状态、按证据判定完成、失败退避重试、并把唯一下一步送回模型续跑。

**Architecture:** 纯函数状态机（`board/`，不 import pi）+ 进程子系统（`jobs/`，不懂任务）+ 唯一跨界写入层（`bind/`）+ 唤醒调度（`wake/`）+ 只读面板（`ui/`）。两条事实源：Task 权威在会话分支 custom entry，Job 权威在项目 sidecar；链级权威状态（finalized/evidenceApplied/pendingReverify）落 sidecar，Evidence 只是 owner 会话的展示副本。

**Tech Stack:** TypeScript（ESM，pi 用 jiti 直接加载 `.ts`）、typebox（参数 schema）、vitest（测试）、node:child_process / node:fs。pi 宿主提供 `@earendil-works/pi-coding-agent`、`pi-tui`、`pi-ai`、`pi-agent-core`、`typebox`，一律列 peerDependencies 不打包。

**Spec:** `docs/superpowers/specs/2026-11-21-vigil-todo-design.md`（v12，check 已 APPROVE）。执行者必须同时读规格与本计划；本计划的每条规则编号 R1–R17、用例编号 F1–F105 均指向该规格。

## Global Constraints

- 扩展名 `vigil-todo`；入口 `extensions/vigil-todo.ts`；主命令 `/vigil-todo`；配置键 `vigilTodo`；唤醒消息 `customType: "vigil-todo-wake"`。
- 工具名保留 `todo` / `bg_run` / `bg_list` / `bg_kill`，**不得改名**。`todo` 的 action 枚举只新增 `verify`。
- 快照 custom entry type 沿用 `"rpiv-todo-state"`（兼容单向：读旧 4 状态，旧包读不了 `parked`）。
- sidecar 路径 `/tmp/bg-run/<hash(cwd)>/jobs.json`；claim 文件 `/tmp/bg-run/<hash(cwd)>/claims/<rootId>.{adopt,respawn}.json`；心跳 `/tmp/bg-run/<hash(cwd)>/sessions/<sessionId>.json`。
- 默认值（逐字取自规格）：`wipLimit: 3`、`retries: 3`（总尝试 4）、退避 `立即 → 30s → 2min`、`staleReverify: 1`、`maxTurns: 50`、`maxConcurrentJobs: 10`、`completedTtlMs: 7 天`、面板 `12` 内容行、折叠键 `ctrl+shift+t`、日志尾 `20` 行 / `≤8KB`、唤醒 `≤1200 token`、补偿守卫 `10min`、心跳过期 `15s`、疑似挂死 `10min`、合并窗口 `250ms`、一次性复查 `+20s`。
- `board/` **禁止 import 任何 pi 模块**；作业事实通过注入的 `JobFacts` 接口传入。
- `todo.execute()` 的读→校验→写→`appendEntry` **全程无 `await`**（L2 唯一权威）。**不设** `executionMode:"sequential"`。
- 每链 job 总数 ≤ `1 + retries + staleReverify` = 5；`attempt` 含重验分支内的失败重试；重验分支后代永不再触发重验。
- `chainFinal` **只由 `projectFinal` 合成**，per-job 证据一律 `chainFinal:false`。
- `notifyState` / `wakeId` / `notifySentAt` **只在 root 记录有效**，per-job 不读不写。
- 拒绝一律返回 `{isError:true, content:[{type:"text",text}], details:{error}}`，文案必须给出下一步真实调用形态。
- 单一构建分支 `feat/vigil-todo`；每个 Task 结束即 commit；**不新建分支、不开中间 PR**；全部完成后由人审核最终 PR。

## Review Focus

规格是愿景文档，它对下列输入保持沉默，但沉默不等于允许崩掉。每条都已在对应 Task 里加了测试：

1. **模型传入畸形/超量参数**（`subject` 空串、`blockedBy` 含自身或不存在 id、`metadata` 非对象、`tasks[]` 双重 JSON 编码）→ 期望：返回 `isError` 且状态不变，不抛异常、不写入半个 board。（T3、T7）
2. **sidecar 与快照被外部破坏**（`jobs.json` 非法 JSON、`jobs` 非数组、单条 job 缺字段、快照 `tasks` 被截断）→ 期望：留档 + 从空开始 + notify，另一侧不受影响。（T6、T9）
3. **同一事件重复到达**（`exit` 与 `close` 都触发、timer 与 `session_start` 同时 sweep、同一 job 重复 finalize）→ 期望：证据一条、投递一次、链不重复终结。（T10、T15、T16）
4. **时钟与文件系统异常**（`retryAt` 在过去很久、claim 文件残留、日志文件被删、非 git 目录、git 命令失败）→ 期望：不悬置、不无限重试、fp 判 unknown 而非 fresh。（T8、T11、T12、T13）
5. **headless / 无 UI / 旧包共存**（`ctx.hasUI === false`、`getAllTools()` 里 `todo` 不属于自己）→ 期望：UI 全 no-op；冲突时 notify error 且不注册事件处理器。（T7、T20）

---

## File Structure

```
package.json                      pi manifest + scripts + peerDeps
tsconfig.json                     ESM/strict，供 tsc --noEmit 与编辑器
vitest.config.ts                  node 环境，tests/**
extensions/vigil-todo.ts          注册面：工具/命令/快捷键/事件接线（薄）
src/board/types.ts                Task/Evidence/BoardState/BoardCounters + 常量
src/board/invariants.ts           转移表 + R1/R4/R7/R8/R9/R13/R14/R16/R17 判定（纯）
src/board/evidence.ts             R2/R3/R5/R6/R15 证据判定 + 环形写入 + lastFailure
src/board/reducer.ts              applyMutation：create/update/delete/clear/list/get
src/board/selectors.ts            wipCount/selectNext/completedSummary
src/board/replay.ts               快照解码 + 迁移 fallback（inProgressSince ?? statusSince ?? 0）
src/board/store.ts                每会话 Map + commit/replace/evict + 前台指针
src/jobs/types.ts                 Job/JobStatus
src/jobs/store.ts                 sidecar 原子读写 + 损坏留档 + GC
src/jobs/spawn.ts                 spawn(cwd) + startStamp + 日志 fd
src/jobs/monitor.ts               exit/close 优先 + 单 timer（无作业停表）
src/jobs/chain.ts                 rootId/attempt/派生上限/chainTerminated/重验分支继承
src/jobs/capacity.ts              派生 reservedSlots + 新 spawn / respawn 两套准入
src/jobs/kill.ts                  SIGTERM→SIGKILL + kill.requestedBy + 清 retryAt
src/jobs/claims.ts                O_EXCL 创建 + rename takeover + 过期判定
src/jobs/heartbeat.ts             会话心跳写入 + 活跃/疑似挂死判定
src/bind/autofill.ts              job 终结 → evidence → 自动 completed/parked（人工优先）
src/bind/finalize.ts              finalizeChain（链级）+ projectFinal（owner 投影）
src/bind/sweep.ts                 defer 释放 + retryAt 到期 respawn + root 粒度补偿扫描
src/bind/adopt.ts                 孤儿链收养 A–F（心跳/认领/定位/重编号/冻结）
src/wake/deliver.ts               tryDeliver 单一判据 + counters 记账
src/wake/compose.ts               唤醒文案（next / 三个动作 / 日志尾 / fp reason）
src/wake/ack.ts                   双路 ack（message_start/end + boundary 后 agent_start）
src/ui/overlay.ts                 widget 生命周期 + 行预算
src/ui/panel.ts                   /vigil-todo /todos /bg /doctor 文本
src/lib/config.ts                 默认值 + 优先级链 + mtime 缓存
src/lib/atomic.ts                 tmp + rename 原子写
src/lib/tail.ts                   按字节尾读 ≤8KB 取末 N 行
src/lib/fingerprint.ts            git 指纹采集 + 延迟 verdict（两集合）
src/lib/sanitize.ts               终端控制字符清洗
src/tool/schema.ts                typebox 参数 schema（含只读字段声明）
src/tool/envelope.ts              成功/拒绝信封 + details 快照
src/tool/register.ts              todo/bg_* 注册 + L1 预检 + 冲突自检
tests/**                          与 src 同构，每 Task 一个或多个测试文件
docs/superpowers/plans/…          本计划
```

---

### Task 1: 项目骨架、领域类型与配置优先级链

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/board/types.ts`, `src/jobs/types.ts`, `src/lib/config.ts`
- Test: `tests/lib/config.test.ts`, `tests/board/types.test.ts`

**Interfaces:**
- Consumes: 无（首个 Task）
- Produces:
  - `Status`, `FpVerdict`, `Evidence`, `LastFailure`, `Task`, `BoardCounters`, `BoardState`, `EVIDENCE_RING`, `emptyBoard()`
  - `JobStatus`, `Job`
  - `VigilConfig`, `DEFAULTS`, `resolveConfig(sources)`, `createConfigLoader(read)`

- [ ] **Step 1: 写失败测试 — 配置优先级与非法值**

```ts
// tests/lib/config.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULTS, resolveConfig } from "../../src/lib/config.js";

describe("resolveConfig", () => {
  it("空来源全部走默认值", () => {
    expect(resolveConfig({})).toEqual(DEFAULTS);
    expect(DEFAULTS.wipLimit).toBe(3);
    expect(DEFAULTS.retries).toBe(3);
    expect(DEFAULTS.retryDelaysMs).toEqual([0, 30_000, 120_000]);
    expect(DEFAULTS.maxTurns).toBe(50);
    expect(DEFAULTS.staleReverify).toBe(1);
    expect(DEFAULTS.maxConcurrentJobs).toBe(10);
  });

  it("file > settings.vigilTodo > legacy.bgRun > 默认", () => {
    const c = resolveConfig({
      file: { wipLimit: 5 },
      settings: { wipLimit: 4, maxTurns: 9 },
      legacy: { maxConcurrentJobs: 2, maxTurns: 7 },
    });
    expect(c.wipLimit).toBe(5);
    expect(c.maxTurns).toBe(9);
    expect(c.maxConcurrentJobs).toBe(2);
  });

  it("非法值退回默认，不抛异常", () => {
    const c = resolveConfig({
      file: { wipLimit: 0, retries: -1, maxTurns: "50", tailLines: 1.5, collapseKey: "" },
    });
    expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
    expect(c.retries).toBe(DEFAULTS.retries);
    expect(c.maxTurns).toBe(DEFAULTS.maxTurns);
    expect(c.tailLines).toBe(DEFAULTS.tailLines);
    expect(c.collapseKey).toBe(DEFAULTS.collapseKey);
  });

  it("collapseKey 允许 off 哨兵", () => {
    expect(resolveConfig({ file: { collapseKey: "off" } }).collapseKey).toBe("off");
  });
});
```

```ts
// tests/board/types.test.ts
import { expect, it } from "vitest";
import { EVIDENCE_RING, emptyBoard } from "../../src/board/types.js";

it("emptyBoard 计数器归零且不复用数组引用", () => {
  const a = emptyBoard();
  const b = emptyBoard();
  expect(a).toEqual({ tasks: [], nextId: 1, counters: { turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 } });
  a.tasks.push({ id: 1, subject: "x", status: "pending" });
  expect(b.tasks).toHaveLength(0);
  expect(EVIDENCE_RING).toBe(8);
});
```

- [ ] **Step 2: 建骨架并运行测试确认失败**

`package.json`：

```json
{
  "name": "pi-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/vigil-todo.ts"] },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^3.0.0", "typebox": "^1.4.7" }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["node"], "allowImportingTsExtensions": true, "verbatimModuleSyntax": true
  },
  "include": ["src", "extensions", "tests"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"] } });
```

`.gitignore`：`node_modules/`、`coverage/`、`*.log`

Run: `npm install && npm test`
Expected: FAIL — `Failed to resolve import "../../src/lib/config.js"`

- [ ] **Step 3: 写领域类型**

`src/board/types.ts`：

```ts
export type Status = "pending" | "in_progress" | "parked" | "completed" | "deleted";
export type FpVerdict = "fresh" | "stale" | "unknown";

export interface Evidence {
  ok: boolean;
  kind: "job" | "command" | "manual";
  origin: "async" | "tool";
  chainFinal: boolean;
  trigger?: "self" | "external";
  at: number;
  exitCode?: number | null;
  known: boolean;
  fp: FpVerdict;
  accepted?: boolean;
  ref?: string;
  note?: string;
}

export interface LastFailure { exitCode: number | null; ref: string; at: number; note?: string }

export interface Task {
  id: number; subject: string; status: Status;
  description?: string; activeForm?: string; owner?: string;
  blockedBy?: number[]; metadata?: Record<string, unknown>;
  verify?: { kind: "command"; command: string };
  verifyChanged?: boolean;
  jobs?: string[];
  evidence?: Evidence[];
  lastFailure?: LastFailure;
  statusSince?: number;
  inProgressSince?: number;
  park?: { reason: string; at: number; from: Status };
  defer?: { untilRoot: string; reason: string; at: number };
}

export interface BoardCounters { turnsUsed: number; wakeWatermark: number; renudgeBudget: number }
export interface BoardState { tasks: Task[]; nextId: number; counters: BoardCounters }

export const EVIDENCE_RING = 8;

export function emptyBoard(): BoardState {
  return { tasks: [], nextId: 1, counters: { turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 } };
}
```

`src/jobs/types.ts`：

```ts
import type { FpVerdict } from "../board/types.js";

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface Job {
  id: string; label: string; command: string; logPath: string; cwd: string;
  pid: number; status: JobStatus;
  exitCode: number | null; signal?: string | null; exitCodeKnown: boolean;
  startedAt: number; endedAt: number | null; startStamp?: string;
  fpStart?: string; fpEnd?: string; fpVerdict: FpVerdict;
  interferers: string[]; overlapUnfinished: string[];
  staleReverifyOf?: string;
  taskId?: number; sessionId?: string;
  rootId: string; retryOf?: string; attempt: number;
  retryAt?: number;
  finalized?: boolean;
  finalResult?: { ok: boolean; note: string; trigger: "self" | "external"; at: number };
  pendingReverify?: boolean;
  kill?: { requestedBy: "self" | "external"; at: number };
  evidenceApplied: boolean;
  notifyState: "pending" | "sent" | "acked";
  notifySentAt?: number; wakeId?: string;
}
```

- [ ] **Step 4: 写配置解析**

`src/lib/config.ts`：

```ts
export interface VigilConfig {
  wipLimit: number; retries: number; retryDelaysMs: number[]; staleReverify: number;
  maxTurns: number; maxConcurrentJobs: number; completedTtlMs: number;
  tailLines: number; maxTailBytes: number; maxWidgetLines: number; collapseKey: string;
  notifyRetryMs: number; heartbeatStaleMs: number; hungSuspectMs: number;
  wakeMergeMs: number; adoptRecheckMs: number;
}

export const DEFAULTS: VigilConfig = {
  wipLimit: 3, retries: 3, retryDelaysMs: [0, 30_000, 120_000], staleReverify: 1,
  maxTurns: 50, maxConcurrentJobs: 10, completedTtlMs: 7 * 24 * 3600_000,
  tailLines: 20, maxTailBytes: 8192, maxWidgetLines: 12, collapseKey: "ctrl+shift+t",
  notifyRetryMs: 600_000, heartbeatStaleMs: 15_000, hungSuspectMs: 600_000,
  wakeMergeMs: 250, adoptRecheckMs: 20_000,
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;

/** file > settings.vigilTodo > legacy.bgRun > DEFAULTS；非法值逐项退回默认。 */
export function resolveConfig(s: { file?: unknown; settings?: unknown; legacy?: unknown }): VigilConfig {
  const layers = [s.legacy, s.settings, s.file].filter(isBag);
  const pick = (k: keyof VigilConfig): unknown => {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][k] !== undefined) return layers[i][k];
    return undefined;
  };
  const out = { ...DEFAULTS };
  const mins: Partial<Record<keyof VigilConfig, number>> = {
    wipLimit: 1, retries: 0, staleReverify: 0, maxTurns: 1, maxConcurrentJobs: 1,
    completedTtlMs: 1, tailLines: 1, maxTailBytes: 1, maxWidgetLines: 3,
    notifyRetryMs: 1, heartbeatStaleMs: 1, hungSuspectMs: 1, wakeMergeMs: 0, adoptRecheckMs: 1,
  };
  for (const [k, min] of Object.entries(mins)) {
    const v = posInt(pick(k as keyof VigilConfig), min as number);
    if (v !== undefined) (out as unknown as Bag)[k] = v;
  }
  const delays = pick("retryDelaysMs");
  if (Array.isArray(delays) && delays.length > 0 && delays.every((d) => posInt(d, 0) !== undefined)) {
    out.retryDelaysMs = delays as number[];
  }
  const key = pick("collapseKey");
  if (typeof key === "string" && key.trim() !== "") out.collapseKey = key.trim().toLowerCase();
  return out;
}

/** mtime 缓存：同一 mtime 不重复解析（规格 §10.1「每渲染读配置」缺陷）。 */
export function createConfigLoader(read: () => { mtimeMs: number; sources: { file?: unknown; settings?: unknown; legacy?: unknown } }) {
  let cached: { mtimeMs: number; config: VigilConfig } | undefined;
  return (): VigilConfig => {
    const { mtimeMs, sources } = read();
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, config: resolveConfig(sources) };
    return cached.config;
  };
}
```

`src/board/types.ts` 与 `src/jobs/types.ts` 如上。测试里 `import ... from "../../src/lib/config.js"` 依赖 vitest 的 TS 解析；若解析失败，改为 `.ts` 后缀并同步全计划（本计划统一用 `.js` 后缀 + `moduleResolution: bundler`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS（2 个文件，5 个用例）

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无输出（退出码 0）

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src tests
git commit -m "feat(vigil-todo): 骨架、领域类型与配置优先级链"
```

---

### Task 2: 转移表与结构性规则（R1/R4/R9/R13/R14/R17）

**Files:**
- Create: `src/board/invariants.ts`
- Test: `tests/board/invariants.test.ts`

**Interfaces:**
- Consumes: `Task`, `Status`, `BoardState` (T1)
- Produces:
  - `TRANSITIONS: Record<Status, ReadonlySet<Status>>`
  - `isTransitionValid(from: Status, to: Status): boolean`
  - `JobFacts { hasRunning(taskId: number): boolean; hasBackoff(taskId: number): boolean; startedAt(ref: string): number | undefined; exists(jobId: string): boolean }`
  - `RuleContext { wipLimit: number; facts: JobFacts; now: number }`
  - `checkStructure(state: BoardState, task: Task, params: UpdateParams, ctx: RuleContext): string | undefined`
  - `UpdateParams`（本 Task 定义最小集，T3 扩展）：`{ id: number; status?: Status; reason?: string; defer?: { untilJob: string; reason: string } | null }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/board/invariants.test.ts
import { describe, expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { checkStructure, isTransitionValid, type JobFacts, type RuleContext } from "../../src/board/invariants.js";

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
  hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true, ...over,
});
const ctx = (wipLimit = 3, f: Partial<JobFacts> = {}): RuleContext => ({ wipLimit, facts: facts(f), now: 1000 });
const t = (id: number, over: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...over });
const board = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

describe("转移表", () => {
  it("completed 只能到 deleted；parked 不能由 completed 进入", () => {
    expect(isTransitionValid("completed", "deleted")).toBe(true);
    expect(isTransitionValid("completed", "parked")).toBe(false);
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
    expect(isTransitionValid("deleted", "pending")).toBe(false);
    expect(isTransitionValid("pending", "parked")).toBe(true);
    expect(isTransitionValid("parked", "in_progress")).toBe(true);
  });
  it("同值幂等", () => expect(isTransitionValid("parked", "parked")).toBe(true));
});

describe("R1 WIP 上限", () => {
  it("已满时拒绝第四个 in_progress（F1）", () => {
    const s = board([t(1, { status: "in_progress" }), t(2, { status: "in_progress" }), t(3, { status: "in_progress" }), t(4)]);
    expect(checkStructure(s, s.tasks[3], { id: 4, status: "in_progress" }, ctx())).toMatch(/WIP full \(3\/3\)/);
  });
  it("parked 不占位（F19）", () => {
    const s = board([t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }), t(2)]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx(1))).toBeUndefined();
  });
});

describe("R4 依赖", () => {
  it("依赖 in_progress 时拒绝（F26 反面）", () => {
    const s = board([t(1, { status: "in_progress" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toMatch(/blocked by #1/);
  });
  it("依赖 deleted 视为已满足（F26）", () => {
    const s = board([t(1, { status: "deleted" }), t(2, { blockedBy: [1] })]);
    expect(checkStructure(s, s.tasks[1], { id: 2, status: "in_progress" }, ctx())).toBeUndefined();
  });
});

describe("R9/R13 park 与 defer", () => {
  it("deferred 不许直接开工（F28）", () => {
    const s = board([t(1, { defer: { untilRoot: "bg_a", reason: "r", at: 1 } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "in_progress" }, ctx())).toMatch(/deferred → bg_a/);
  });
  it("parked 施加 defer 被拒并给两步解法（F39）", () => {
    const s = board([t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, defer: { untilJob: "bg_a", reason: "r" } }, ctx()))
      .toMatch(/status:"pending"/);
  });
  it("deferred 施加 park 被拒并给两步解法（F39）", () => {
    const s = board([t(1, { defer: { untilRoot: "bg_a", reason: "r", at: 1 } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "parked", reason: "r" }, ctx())).toMatch(/defer:null/);
  });
});

describe("R14 让位与 defer 前置", () => {
  it("有 running 作业时让位被拒（F54）", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(3, { hasRunning: () => true })))
      .toMatch(/cannot yield or defer/);
  });
  it("有 running 作业时施加 defer 同样被拒（F62）", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, defer: { untilJob: "bg_b", reason: "r" } }, ctx(3, { hasRunning: () => true })))
      .toMatch(/cannot yield or defer/);
  });
  it("有退避链时让位被拒", () => {
    const s = board([t(1, { status: "in_progress" })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "pending" }, ctx(3, { hasBackoff: () => true })))
      .toMatch(/cannot yield or defer/);
  });
});

describe("R17 移交冻结", () => {
  it("adoptedAway 任务拒绝一切变更（F97）", () => {
    const s = board([t(1, { metadata: { adoptedAway: { session: "sess-B" } } })]);
    expect(checkStructure(s, s.tasks[0], { id: 1, status: "in_progress" }, ctx())).toMatch(/sess-B/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/board/invariants.test.ts`
Expected: FAIL — 无法解析 `src/board/invariants.js`

- [ ] **Step 3: 实现**

```ts
// src/board/invariants.ts
import type { BoardState, Status, Task } from "./types.js";

export const TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
  pending: new Set<Status>(["in_progress", "parked", "completed", "deleted"]),
  in_progress: new Set<Status>(["completed", "parked", "pending", "deleted"]),
  parked: new Set<Status>(["in_progress", "pending", "completed", "deleted"]),
  completed: new Set<Status>(["deleted"]),
  deleted: new Set<Status>(),
};

export function isTransitionValid(from: Status, to: Status): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export interface JobFacts {
  hasRunning(taskId: number): boolean;
  hasBackoff(taskId: number): boolean;
  startedAt(ref: string): number | undefined;
  exists(jobId: string): boolean;
}
export interface RuleContext { wipLimit: number; facts: JobFacts; now: number }
export interface UpdateParams {
  id: number; status?: Status; reason?: string;
  defer?: { untilJob: string; reason: string } | null;
}

const settled = (s: Status) => s === "completed" || s === "deleted";

/** 结构性规则；证据类规则在 evidence.ts。返回错误文案或 undefined。 */
export function checkStructure(state: BoardState, task: Task, p: UpdateParams, ctx: RuleContext): string | undefined {
  const away = task.metadata?.adoptedAway as { session?: string } | undefined;
  if (away) return `#${task.id} 已移交到会话 ${away.session ?? "?"}，请在该会话操作`;

  if (p.status !== undefined && !isTransitionValid(task.status, p.status)) {
    return `illegal transition ${task.status} → ${p.status}`;
  }

  // R13 互斥（先判，避免后续规则给出误导文案）
  if (p.defer && task.status === "parked") {
    return `#${task.id} is parked; 先 todo({action:"update", id:${task.id}, status:"pending"}) 再 defer`;
  }
  if (p.status === "parked" && task.defer) {
    return `#${task.id} is deferred; 先 todo({action:"update", id:${task.id}, defer:null}) 再 park`;
  }

  // R14 让位 / defer 前置
  const yielding = task.status === "in_progress" && p.status === "pending";
  if ((yielding || p.defer) && (ctx.facts.hasRunning(task.id) || ctx.facts.hasBackoff(task.id))) {
    return `#${task.id} has a running job; cannot yield or defer → bg_kill({job_id:"…"}) 或等它结束`;
  }

  // R9 deferred 不许直接开工
  if (p.status === "in_progress" && task.defer) {
    return `#${task.id} is deferred → ${task.defer.untilRoot} → todo({action:"update", id:${task.id}, defer:null})`;
  }

  // R1 WIP
  if (p.status === "in_progress" && task.status !== "in_progress") {
    const active = state.tasks.filter((x) => x.status === "in_progress");
    if (active.length >= ctx.wipLimit) {
      return `WIP full (${active.length}/${ctx.wipLimit}): ${active.map((x) => `#${x.id}`).join(" ")}`
        + ` → todo({action:"update", id:${active[0].id}, status:"parked", reason:"…"})`;
    }
  }

  // R4 依赖
  if (p.status === "in_progress" || p.status === "completed") {
    for (const dep of task.blockedBy ?? []) {
      const d = state.tasks.find((x) => x.id === dep);
      if (!d) return `#${task.id} blocked by #${dep} (missing) → todo({action:"update", id:${task.id}, removeBlockedBy:[${dep}]})`;
      if (!settled(d.status)) {
        return `#${task.id} is blocked by #${d.id} (${d.status}) → todo({action:"update", id:${task.id}, removeBlockedBy:[${d.id}]})`;
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/board/invariants.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/board/invariants.ts tests/board/invariants.test.ts
git commit -m "feat(vigil-todo): 转移表与结构性规则 R1/R4/R9/R13/R14/R17"
```

---

### Task 3: reducer 基础 mutation、只读字段集与拒绝信封（R10/R16）

**Files:**
- Create: `src/board/reducer.ts`, `src/tool/envelope.ts`
- Modify: `src/board/invariants.ts`（扩展 `UpdateParams` 为完整 `MutationParams`）
- Test: `tests/board/reducer.test.ts`, `tests/tool/envelope.test.ts`

**Interfaces:**
- Consumes: T1 类型、T2 `checkStructure`/`RuleContext`
- Produces:
  - `MutationParams`（完整）、`Op`、`ApplyResult`
  - `applyMutation(state: BoardState, params: MutationParams, ctx: RuleContext): ApplyResult`
  - `READONLY_FIELDS: readonly string[]`
  - `buildResult(params, state, op): { content: {type:"text";text:string}[]; details: Snapshot; isError?: boolean }`
  - `Snapshot { action: string; params: Record<string, unknown>; tasks: Task[]; nextId: number; counters: BoardCounters; error?: string }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/board/reducer.test.ts
import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { applyMutation } from "../../src/board/reducer.js";
import type { JobFacts, RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true } as JobFacts,
});

describe("create", () => {
  it("单条与批量分配连续 id", () => {
    const a = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx());
    expect(a.op.kind).toBe("create");
    const b = applyMutation(a.state, { action: "create", tasks: [{ subject: "b" }, { subject: "c" }] }, ctx());
    expect(b.state.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(b.state.nextId).toBe(4);
  });
  it("空 subject 拒绝且状态不变（Review Focus 1）", () => {
    const s = emptyBoard();
    const r = applyMutation(s, { action: "create", subject: "   " }, ctx());
    expect(r.op).toEqual({ kind: "error", message: "subject required for create" });
    expect(r.state).toBe(s);
  });
  it("subject 与 tasks[] 互斥", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", tasks: [{ subject: "b" }] }, ctx());
    expect(r.op.kind).toBe("error");
  });
  it("blockedBy 自引用 / 不存在 / 已删除 均拒（Review Focus 1）", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "b", blockedBy: [99] }, ctx()).op.kind).toBe("error");
    s = applyMutation(s, { action: "update", id: 1, status: "deleted" }, ctx()).state;
    expect(applyMutation(s, { action: "create", subject: "c", blockedBy: [1] }, ctx()).op.kind).toBe("error");
    expect(applyMutation(s, { action: "update", id: 1, addBlockedBy: [1] }, ctx()).op.kind).toBe("error");
  });
  it("metadata 非对象拒绝（Review Focus 1）", () => {
    const r = applyMutation(emptyBoard(), { action: "create", subject: "a", metadata: "x" as never }, ctx());
    expect(r.op.kind).toBe("error");
  });
});

describe("R16 只读字段", () => {
  it.each(["jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged"])(
    "模型写 %s 被拒（F66）", (field) => {
      const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
      const r = applyMutation(s, { action: "update", id: 1, [field]: [] } as never, ctx());
      expect(r.op.kind).toBe("error");
      expect((r.op as { message: string }).message).toContain(field);
    });
});

describe("update 与 inProgressSince", () => {
  it("进入 in_progress 刷新 inProgressSince", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].inProgressSince).toBe(1000);
    expect(s.tasks[0].statusSince).toBe(1000);
  });
  it("无可变字段拒绝", () => {
    const s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "update", id: 1 }, ctx()).op.kind).toBe("error");
  });
  it("无变更返回 changed:false", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    const r = applyMutation(s, { action: "update", id: 1, subject: "a" }, ctx());
    expect(r.op).toMatchObject({ kind: "update", changed: false });
  });
});

describe("delete 出口", () => {
  it("pending 无产出可删；有 jobs 或 evidence 不可删", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("delete");
    s = applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;
    s.tasks[0].jobs = ["bg_a"];
    expect(applyMutation(s, { action: "delete", id: 1 }, ctx()).op.kind).toBe("error");
  });
});
```

```ts
// tests/tool/envelope.test.ts
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { buildResult } from "../../src/tool/envelope.js";

it("拒绝带 isError 与 details.error（F29）", () => {
  const r = buildResult({ action: "update", id: 1 }, emptyBoard(), { kind: "error", message: "boom" });
  expect(r.isError).toBe(true);
  expect(r.details.error).toBe("boom");
  expect(r.content[0].text).toContain("boom");
});

it("成功不带 isError，details 含 counters", () => {
  const r = buildResult({ action: "create", subject: "a" }, emptyBoard(), { kind: "create", ids: [1] });
  expect(r.isError).toBeUndefined();
  expect(r.details.counters).toEqual({ turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/board/reducer.test.ts tests/tool/envelope.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 扩展参数类型并实现 reducer**

在 `src/board/invariants.ts` 末尾追加（替换 T2 的 `UpdateParams` 定义为兼容超集）：

```ts
export interface CreateItem {
  subject: string; description?: string; activeForm?: string;
  blockedBy?: number[]; owner?: string; metadata?: Record<string, unknown>;
  verify?: { kind: "command"; command: string };
}
export interface MutationParams {
  action: "create" | "update" | "list" | "get" | "delete" | "clear" | "verify";
  id?: number; subject?: string; description?: string; activeForm?: string; owner?: string;
  status?: Status; reason?: string; accept?: "stale";
  blockedBy?: number[]; addBlockedBy?: number[]; removeBlockedBy?: number[];
  metadata?: Record<string, unknown>; tasks?: CreateItem[]; includeDeleted?: boolean;
  verify?: { kind: "command"; command: string };
  defer?: { untilJob: string; reason: string } | null;
  [k: string]: unknown;
}
export const READONLY_FIELDS = [
  "jobs", "evidence", "lastFailure", "inProgressSince", "statusSince", "verifyChanged",
] as const;
```

`src/board/reducer.ts`：

```ts
import { READONLY_FIELDS, checkStructure, type MutationParams, type RuleContext } from "./invariants.js";
import { EVIDENCE_RING, emptyBoard, type BoardState, type Status, type Task } from "./types.js";

export type Op =
  | { kind: "create"; ids: number[] }
  | { kind: "update"; id: number; from: Status; to: Status; changed: boolean }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "clear"; count: number }
  | { kind: "list" } | { kind: "get"; task: Task }
  | { kind: "error"; message: string };
export interface ApplyResult { state: BoardState; op: Op }

const err = (state: BoardState, message: string): ApplyResult => ({ state, op: { kind: "error", message } });
const isBag = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

function pushEvidence(task: Task, e: Task["evidence"] extends (infer U)[] | undefined ? U : never): void {
  const ring = [...(task.evidence ?? []), e];
  task.evidence = ring.slice(-EVIDENCE_RING);
}

export function applyMutation(state: BoardState, p: MutationParams, ctx: RuleContext): ApplyResult {
  if (p.action === "create") {
    if (p.subject !== undefined && p.tasks !== undefined) return err(state, "create requires subject or tasks[], not both");
    const items = p.tasks ?? (p.subject !== undefined ? [{ subject: p.subject, description: p.description, activeForm: p.activeForm, blockedBy: p.blockedBy, owner: p.owner, metadata: p.metadata, verify: p.verify }] : []);
    if (items.length === 0) return err(state, "subject required for create");
    const sibling = new Set(items.map((_, i) => state.nextId + i));
    for (const [i, it] of items.entries()) {
      if (typeof it.subject !== "string" || it.subject.trim() === "") return err(state, `tasks[${i}]: subject required for create`);
      if (it.metadata !== undefined && !isBag(it.metadata)) return err(state, "metadata must be an object");
      for (const dep of it.blockedBy ?? []) {
        if (sibling.has(dep)) return err(state, `blockedBy: #${dep} is another item in this batch`);
        const d = state.tasks.find((t) => t.id === dep);
        if (!d) return err(state, `blockedBy: #${dep} not found`);
        if (d.status === "deleted") return err(state, `blockedBy: #${dep} is deleted`);
      }
    }
    const created: Task[] = items.map((it, i) => {
      const t: Task = { id: state.nextId + i, subject: it.subject.trim(), status: "pending", statusSince: ctx.now };
      if (it.description) t.description = it.description;
      if (it.activeForm) t.activeForm = it.activeForm;
      if (it.owner) t.owner = it.owner;
      if (it.blockedBy?.length) t.blockedBy = [...it.blockedBy];
      if (it.metadata) t.metadata = { ...it.metadata };
      if (it.verify) t.verify = { ...it.verify };
      return t;
    });
    return { state: { ...state, tasks: [...state.tasks, ...created], nextId: state.nextId + created.length }, op: { kind: "create", ids: created.map((t) => t.id) } };
  }

  if (p.action === "clear") return { state: { ...emptyBoard(), counters: state.counters }, op: { kind: "clear", count: state.tasks.length } };
  if (p.action === "list") return { state, op: { kind: "list" } };

  if (p.id === undefined) return err(state, `id required for ${p.action}`);
  const idx = state.tasks.findIndex((t) => t.id === p.id);
  if (idx < 0) return err(state, `#${p.id} not found`);
  const cur = state.tasks[idx];
  if (p.action === "get") return { state, op: { kind: "get", task: cur } };

  for (const f of READONLY_FIELDS) {
    if (p[f] !== undefined) return err(state, `${f} is read-only; 由扩展写入，模型不可传`);
  }

  if (p.action === "delete") {
    if (cur.status === "deleted") return err(state, `#${cur.id} is already deleted`);
    if (cur.status !== "completed" && ((cur.jobs?.length ?? 0) > 0 || (cur.evidence?.length ?? 0) > 0)) {
      return err(state, `#${cur.id} has jobs/evidence; 用 status:"parked" 代替删除`);
    }
    const tasks = [...state.tasks];
    tasks[idx] = { ...cur, status: "deleted", statusSince: ctx.now };
    return { state: { ...state, tasks }, op: { kind: "delete", id: cur.id, subject: cur.subject } };
  }

  // update / verify 的结构性校验
  const structural = checkStructure(state, cur, p as never, ctx);
  if (structural) return err(state, structural);

  const next: Task = { ...cur };
  let changed = false;
  const set = <K extends keyof Task>(k: K, v: Task[K]) => {
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) { next[k] = v; changed = true; }
  };
  if (p.subject !== undefined) set("subject", p.subject);
  if (p.description !== undefined) set("description", p.description);
  if (p.activeForm !== undefined) set("activeForm", p.activeForm);
  if (p.owner !== undefined) set("owner", p.owner);
  if (p.metadata !== undefined) {
    if (!isBag(p.metadata)) return err(state, "metadata must be an object");
    const merged: Record<string, unknown> = { ...(cur.metadata ?? {}) };
    for (const [k, v] of Object.entries(p.metadata)) { if (v === null) delete merged[k]; else merged[k] = v; }
    set("metadata", Object.keys(merged).length ? merged : undefined);
  }
  if (p.removeBlockedBy?.length || p.addBlockedBy?.length) {
    let deps = (cur.blockedBy ?? []).filter((d) => !(p.removeBlockedBy ?? []).includes(d));
    for (const d of p.addBlockedBy ?? []) {
      if (d === cur.id) return err(state, `cannot block #${cur.id} on itself`);
      const t = state.tasks.find((x) => x.id === d);
      if (!t) return err(state, `addBlockedBy: #${d} not found`);
      if (t.status === "deleted") return err(state, `addBlockedBy: #${d} is deleted`);
      if (!deps.includes(d)) deps.push(d);
    }
    set("blockedBy", deps.length ? deps : undefined);
  }
  if (p.status !== undefined && p.status !== cur.status) {
    next.status = p.status;
    next.statusSince = ctx.now;
    if (p.status === "in_progress") next.inProgressSince = ctx.now;
    changed = true;
  }
  const tasks = [...state.tasks];
  tasks[idx] = next;
  return { state: { ...state, tasks }, op: { kind: "update", id: cur.id, from: cur.status, to: next.status, changed } };
}

export { pushEvidence };
```

`src/tool/envelope.ts`：

```ts
import type { Op } from "../board/reducer.js";
import type { BoardCounters, BoardState, Task } from "../board/types.js";

export interface Snapshot {
  action: string; params: Record<string, unknown>;
  tasks: Task[]; nextId: number; counters: BoardCounters; error?: string;
}
export interface ToolResult {
  content: { type: "text"; text: string }[]; details: Snapshot; isError?: boolean;
}

export function buildResult(params: Record<string, unknown>, state: BoardState, op: Op): ToolResult {
  const details: Snapshot = {
    action: String(params.action ?? ""), params,
    tasks: state.tasks, nextId: state.nextId, counters: state.counters,
  };
  if (op.kind === "error") {
    details.error = op.message;
    return { content: [{ type: "text", text: `Error: ${op.message}` }], details, isError: true };
  }
  const text =
    op.kind === "create" ? `Created ${op.ids.map((i) => `#${i}`).join(", ")}`
    : op.kind === "update" ? (op.changed ? `Updated #${op.id}${op.from !== op.to ? ` (${op.from} → ${op.to})` : ""}` : `No change: #${op.id}`)
    : op.kind === "delete" ? `Deleted #${op.id}: ${op.subject}`
    : op.kind === "clear" ? `Cleared ${op.count} tasks`
    : op.kind === "get" ? `#${op.task.id} [${op.task.status}] ${op.task.subject}`
    : state.tasks.filter((t) => t.status !== "deleted").map((t) => `[${t.status}] #${t.id} ${t.subject}`).join("\n") || "No tasks";
  return { content: [{ type: "text", text }], details };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS（全部；reducer 12 例 + envelope 2 例）

- [ ] **Step 5: Commit**

```bash
git add src/board/reducer.ts src/board/invariants.ts src/tool/envelope.ts tests
git commit -m "feat(vigil-todo): reducer 基础 mutation、只读字段集与拒绝信封"
```

---

### Task 4: 证据判定与 park/defer/verify 语义（R2/R3/R5/R6/R7/R8/R15）

**Files:**
- Create: `src/board/evidence.ts`
- Modify: `src/board/reducer.ts`（接入证据门与 park/defer/verify 副作用）
- Test: `tests/board/evidence.test.ts`, `tests/board/park-defer.test.ts`

**Interfaces:**
- Consumes: T1–T3
- Produces:
  - `passingEvidence(task: Task, facts: JobFacts, accept?: "stale"): Evidence | undefined`
  - `completionGate(task: Task, facts: JobFacts, accept?: "stale"): string | undefined`
  - `recordFailure(task: Task, f: LastFailure): void`
  - reducer 支持 `status:"parked"+reason`、`defer:{untilJob,reason}`、`defer:null`、`accept:"stale"`、`verify` 改动副作用

- [ ] **Step 1: 写失败测试**

```ts
// tests/board/evidence.test.ts
import { describe, expect, it } from "vitest";
import { completionGate, recordFailure } from "../../src/board/evidence.js";
import { EVIDENCE_RING, type Evidence, type Task } from "../../src/board/types.js";
import type { JobFacts } from "../../src/board/invariants.js";

const facts = (started: Record<string, number> = {}): JobFacts => ({
  hasRunning: () => false, hasBackoff: () => false, exists: () => true,
  startedAt: (ref) => started[ref],
});
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 200, known: true, fp: "fresh", ref: "bg_a", ...o,
});
const task = (o: Partial<Task> = {}): Task => ({
  id: 1, subject: "t", status: "in_progress", jobs: ["bg_a"], inProgressSince: 100, ...o,
});

describe("R3 完成需证据", () => {
  it("无 job 无 verify 的任务零要求", () => {
    expect(completionGate({ id: 1, subject: "t", status: "in_progress" }, facts())).toBeUndefined();
  });
  it("有 job 但无证据 → 拒", () => {
    expect(completionGate(task(), facts({ bg_a: 150 }))).toMatch(/no passing evidence/);
  });
  it("job 证据满足 startedAt >= inProgressSince 且 at >= startedAt → 放行（F4）", () => {
    expect(completionGate(task({ evidence: [ev()] }), facts({ bg_a: 150 }))).toBeUndefined();
  });
  it("作业早于本轮 in_progress → 拒（F42）", () => {
    expect(completionGate(task({ evidence: [ev()] }), facts({ bg_a: 50 }))).toMatch(/no passing evidence/);
  });
  it("verify 证据也要 at >= inProgressSince（F51）", () => {
    const t = task({ jobs: undefined, verify: { kind: "command", command: "npm test" },
      evidence: [ev({ kind: "command", origin: "tool", ref: undefined, at: 50 })] });
    expect(completionGate(t, facts())).toMatch(/no passing evidence/);
  });
  it("inProgressSince=0 迁移态跳过新近度（F52）", () => {
    expect(completionGate(task({ inProgressSince: 0, evidence: [ev({ at: 10 })] }), facts({ bg_a: 5 }))).toBeUndefined();
  });
});

describe("R5/R6", () => {
  it("known:false 不算通过（F5）", () => {
    expect(completionGate(task({ evidence: [ev({ known: false })] }), facts({ bg_a: 150 }))).toMatch(/no passing evidence/);
  });
  it("stale 未接受 → 拒；accept:stale 放行（F20/F21）", () => {
    const t = task({ evidence: [ev({ fp: "stale" })] });
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/stale/);
    expect(completionGate(t, facts({ bg_a: 150 }), "stale")).toBeUndefined();
  });
  it("unknown 不拦（F58）", () => {
    expect(completionGate(task({ evidence: [ev({ fp: "unknown" })] }), facts({ bg_a: 150 }))).toBeUndefined();
  });
});

describe("R2 失败阻断", () => {
  it("lastFailure 无后续通过证据 → 拒（F3）", () => {
    const t = task({ evidence: [ev()] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/unresolved failure/);
  });
  it("环形溢出后 lastFailure 仍阻断（F36）", () => {
    const t = task({ evidence: [] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    for (let i = 0; i < EVIDENCE_RING + 4; i++) t.evidence = [...(t.evidence ?? []), ev({ at: 100 + i })].slice(-EVIDENCE_RING);
    expect(t.evidence).toHaveLength(EVIDENCE_RING);
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/unresolved failure/);
  });
  it("更新的通过证据解除阻断", () => {
    const t = task({ evidence: [ev({ at: 400 })] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    expect(completionGate(t, facts({ bg_a: 150 }))).toBeUndefined();
  });
});
```

```ts
// tests/board/park-defer.test.ts
import { describe, expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { applyMutation } from "../../src/board/reducer.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  wipLimit: 3, now: 1000,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
  ...over,
});
const withTask = () => applyMutation(emptyBoard(), { action: "create", subject: "a" }, ctx()).state;

describe("R7 park", () => {
  it("无 reason 拒（F22）", () => {
    expect(applyMutation(withTask(), { action: "update", id: 1, status: "parked" }, ctx()).op.kind).toBe("error");
  });
  it("带 reason 写入 park 并记 from", () => {
    const r = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "需拍板" }, ctx());
    expect(r.state.tasks[0].park).toEqual({ reason: "需拍板", at: 1000, from: "pending" });
  });
  it("unpark 清除 park", () => {
    let s = applyMutation(withTask(), { action: "update", id: 1, status: "parked", reason: "r" }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
    expect(s.tasks[0].park).toBeUndefined();
  });
});

describe("R8 defer", () => {
  it("缺 reason 或 untilJob 不存在均拒（F27）", () => {
    expect(applyMutation(withTask(), { action: "update", id: 1, defer: { untilJob: "bg_a", reason: "" } }, ctx()).op.kind).toBe("error");
    const c = ctx({ facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => false } });
    expect(applyMutation(withTask(), { action: "update", id: 1, defer: { untilJob: "bg_x", reason: "r" } }, c).op.kind).toBe("error");
  });
  it("写入 defer.untilRoot 并置 pending；defer:null 清除", () => {
    let s = applyMutation(withTask(), { action: "update", id: 1, defer: { untilJob: "bg_a", reason: "冲突" } }, ctx()).state;
    expect(s.tasks[0].defer).toEqual({ untilRoot: "bg_a", reason: "冲突", at: 1000 });
    expect(s.tasks[0].status).toBe("pending");
    s = applyMutation(s, { action: "update", id: 1, defer: null }, ctx()).state;
    expect(s.tasks[0].defer).toBeUndefined();
  });
});

describe("R15 verify 改动", () => {
  it("改命令写 manual 证据并禁用自动完成（F53）", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "true" } }, ctx()).state;
    const t = s.tasks[0];
    expect(t.verifyChanged).toBe(true);
    expect(t.evidence?.at(-1)).toMatchObject({ kind: "manual", origin: "tool", ok: false });
    expect(t.evidence?.at(-1)?.note).toContain("npm test");
  });
  it("同命令重复设置不产生副作用", () => {
    let s = applyMutation(emptyBoard(), { action: "create", subject: "a", verify: { kind: "command", command: "npm test" } }, ctx()).state;
    s = applyMutation(s, { action: "update", id: 1, verify: { kind: "command", command: "npm test" } }, ctx()).state;
    expect(s.tasks[0].verifyChanged).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/board/evidence.test.ts tests/board/park-defer.test.ts`
Expected: FAIL — `completionGate` 未定义；park/defer 断言失败

- [ ] **Step 3: 实现证据门**

```ts
// src/board/evidence.ts
import type { JobFacts } from "./invariants.js";
import { EVIDENCE_RING, type Evidence, type LastFailure, type Task } from "./types.js";

/** R2/R3/R5/R6：返回满足全部判据的通过证据，否则 undefined。 */
export function passingEvidence(task: Task, facts: JobFacts, accept?: "stale"): Evidence | undefined {
  const since = task.inProgressSince ?? 0;
  return (task.evidence ?? []).find((e) => {
    if (!e.ok || !e.known) return false;                                  // R5
    if (e.fp === "stale" && !(accept === "stale" || e.accepted)) return false; // R6
    if (since === 0) return true;                                         // R2-7 迁移态
    if (e.kind === "job") {
      const started = e.ref ? facts.startedAt(e.ref) : undefined;
      return started !== undefined && started >= since && e.at >= started;
    }
    return e.at >= since;                                                 // R2-6 verify/manual
  });
}

/** 完成门；返回拒绝文案或 undefined。 */
export function completionGate(task: Task, facts: JobFacts, accept?: "stale"): string | undefined {
  const f = task.lastFailure;
  if (f && !(task.evidence ?? []).some((e) => e.ok && e.known && e.at > f.at)) {
    return `#${task.id} has unresolved failure (${f.ref} exit ${f.exitCode}) → todo({action:"verify", id:${task.id}})`;
  }
  const needsEvidence = (task.jobs?.length ?? 0) > 0 || task.verify !== undefined;
  if (!needsEvidence) return undefined;
  const pass = passingEvidence(task, facts, accept);
  if (pass) return undefined;
  const staleOnly = (task.evidence ?? []).some((e) => e.ok && e.known && e.fp === "stale");
  if (staleOnly && accept !== "stale") {
    return `#${task.id} evidence stale → todo({action:"update", id:${task.id}, status:"completed", accept:"stale"}) 或 todo({action:"verify", id:${task.id}})`;
  }
  return `#${task.id} has no passing evidence since it started → todo({action:"verify", id:${task.id}})`;
}

export function recordFailure(task: Task, f: LastFailure): void { task.lastFailure = f; }

export function appendEvidence(task: Task, e: Evidence): void {
  task.evidence = [...(task.evidence ?? []), e].slice(-EVIDENCE_RING);
}
```

- [ ] **Step 4: reducer 接入 park/defer/verify 与完成门**

在 `src/board/reducer.ts` 的 update 分支中，`checkStructure` 之后、字段赋值之前插入：

```ts
  if (p.status === "parked" && (typeof p.reason !== "string" || p.reason.trim() === "")) {
    return err(state, `park requires reason → todo({action:"update", id:${cur.id}, status:"parked", reason:"…"})`);
  }
  if (p.defer) {
    if (typeof p.defer.reason !== "string" || p.defer.reason.trim() === "") return err(state, "defer requires reason");
    if (!p.defer.untilJob || !ctx.facts.exists(p.defer.untilJob)) return err(state, `defer untilJob ${p.defer.untilJob} not found`);
  }
  if (p.status === "completed") {
    const gate = completionGate(cur, ctx.facts, p.accept);
    if (gate) return err(state, gate);
  }
```

在字段赋值段落末尾（`p.status` 处理之后）追加：

```ts
  if (p.defer) {
    next.defer = { untilRoot: p.defer.untilJob, reason: p.defer.reason.trim(), at: ctx.now };
    if (next.status === "in_progress") { next.status = "pending"; next.statusSince = ctx.now; }
    changed = true;
  } else if (p.defer === null && cur.defer) {
    delete next.defer; changed = true;
  }
  if (p.status === "parked") { next.park = { reason: p.reason!.trim(), at: ctx.now, from: cur.status }; changed = true; }
  if (p.status !== undefined && p.status !== "parked" && cur.park) { delete next.park; changed = true; }
  if (p.status === "completed" && p.accept === "stale") {
    const target = [...(next.evidence ?? [])].reverse().find((e) => e.fp === "stale");
    if (target) { target.accepted = true; changed = true; }
  }
  if (p.verify && p.verify.command !== cur.verify?.command) {
    appendEvidence(next, {
      ok: false, kind: "manual", origin: "tool", chainFinal: false, at: ctx.now, known: true, fp: "unknown",
      note: `verify command changed: ${cur.verify?.command ?? "(none)"} → ${p.verify.command}`,
    });
    next.verify = { kind: "command", command: p.verify.command };
    next.verifyChanged = true;
    changed = true;
  }
```

并在文件顶部 import：`import { appendEvidence, completionGate } from "./evidence.js";`

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（evidence 11 例 + park-defer 8 例 + 既有全部）

- [ ] **Step 6: Commit**

```bash
git add src/board/evidence.ts src/board/reducer.ts tests
git commit -m "feat(vigil-todo): 证据门 R2/R3/R5/R6 与 park/defer/verify 语义"
```

---

### Task 5: selectors、replay 迁移与每会话 store

**Files:**
- Create: `src/board/selectors.ts`, `src/board/replay.ts`, `src/board/store.ts`
- Test: `tests/board/selectors.test.ts`, `tests/board/replay.test.ts`, `tests/board/store.test.ts`

**Interfaces:**
- Consumes: T1–T4
- Produces:
  - `wipCount(state): number`
  - `selectNext(state, wipLimit, capacityFull): Task | undefined`
  - `completedSummary(state): { done: number; total: number; allExit0: boolean; fpUnknown: number; reverified: number; verifyChanged: number }`
  - `decodeSnapshot(v: unknown): BoardState | undefined`
  - `replayBranch(entries: Iterable<unknown>): BoardState`
  - `createBoardStore()` → `{ get(sid), commit(sid, state), replace(sid, state), evict(sid), setForeground(sid), foreground(), renderState() }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/board/selectors.test.ts
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { completedSummary, selectNext, wipCount } from "../../src/board/selectors.js";

const t = (id: number, o: Partial<Task> = {}): Task => ({ id, subject: `t${id}`, status: "pending", ...o });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });

it("WIP 满或容量满时 next 为空（F40）", () => {
  const s = b([t(1, { status: "in_progress" }), t(2)]);
  expect(selectNext(s, 1, false)).toBeUndefined();
  expect(selectNext(s, 3, true)).toBeUndefined();
  expect(selectNext(s, 3, false)?.id).toBe(2);
});

it("跳过 parked / deferred / 依赖未清，按 id 升序（F19）", () => {
  const s = b([
    t(1, { status: "parked", park: { reason: "r", at: 1, from: "pending" } }),
    t(2, { defer: { untilRoot: "bg_a", reason: "r", at: 1 } }),
    t(3, { blockedBy: [1] }),
    t(4),
  ]);
  expect(selectNext(s, 3, false)?.id).toBe(4);
  expect(wipCount(s)).toBe(0);
});

it("completed 汇总统计 fp:? 与 reverified（F58）", () => {
  const done = (id: number, fp: "fresh" | "unknown", note?: string): Task => t(id, {
    status: "completed",
    evidence: [{ ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp, ref: `bg_${id}`, exitCode: 0, note }],
  });
  const s = b([done(1, "fresh"), done(2, "unknown"), done(3, "fresh", "reverified"), t(4)]);
  expect(completedSummary(s)).toMatchObject({ done: 3, total: 4, allExit0: true, fpUnknown: 1, reverified: 1 });
});
```

```ts
// tests/board/replay.test.ts
import { expect, it } from "vitest";
import { decodeSnapshot, replayBranch } from "../../src/board/replay.js";
import { emptyBoard } from "../../src/board/types.js";

const snap = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  action: "update", params: {}, tasks, nextId: tasks.length + 1,
  counters: { turnsUsed: 7, wakeWatermark: 5, renudgeBudget: 1 }, ...extra,
});

it("旧 4 状态快照可读，inProgressSince 走 fallback（F11/F52）", () => {
  const s = decodeSnapshot(snap([{ id: 1, subject: "a", status: "in_progress", statusSince: 42 }]));
  expect(s?.tasks[0].inProgressSince).toBe(42);
  const s0 = decodeSnapshot(snap([{ id: 1, subject: "a", status: "in_progress" }]));
  expect(s0?.tasks[0].inProgressSince).toBe(0);
});

it("parked 状态可解码", () => {
  const s = decodeSnapshot(snap([{ id: 1, subject: "a", status: "parked", park: { reason: "r", at: 1, from: "pending" } }]));
  expect(s?.tasks[0].status).toBe("parked");
});

it("非法快照整体丢弃，不抛异常（Review Focus 2）", () => {
  expect(decodeSnapshot(null)).toBeUndefined();
  expect(decodeSnapshot({ tasks: "x", nextId: 1 })).toBeUndefined();
  expect(decodeSnapshot(snap([{ id: 1 }]))).toBeUndefined();
  expect(decodeSnapshot(snap([{ id: 1, subject: "a", status: "bogus" }]))).toBeUndefined();
});

it("counters 缺失时归零，存在时保留（F37）", () => {
  expect(decodeSnapshot({ tasks: [], nextId: 1 })?.counters).toEqual({ turnsUsed: 0, wakeWatermark: 0, renudgeBudget: 0 });
  expect(decodeSnapshot(snap([]))?.counters.turnsUsed).toBe(7);
});

it("分支取最后一条有效快照；无则空 board（F9）", () => {
  const entries = [
    { type: "custom", customType: "rpiv-todo-state", data: snap([{ id: 1, subject: "a", status: "pending" }]) },
    { type: "message", message: { role: "assistant" } },
    { type: "custom", customType: "rpiv-todo-state", data: snap([{ id: 1, subject: "a", status: "completed" }]) },
    { type: "custom", customType: "rpiv-todo-state", data: { broken: true } },
  ];
  expect(replayBranch(entries).tasks[0].status).toBe("completed");
  expect(replayBranch([])).toEqual(emptyBoard());
});

it("无 custom entry 时回退 toolResult.details", () => {
  const entries = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: snap([{ id: 1, subject: "a", status: "pending" }]) } }];
  expect(replayBranch(entries).tasks).toHaveLength(1);
});
```

```ts
// tests/board/store.test.ts
import { expect, it } from "vitest";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";

it("会话隔离，互不串写（F10 基础）", () => {
  const s = createBoardStore();
  const a = emptyBoard(); a.tasks.push({ id: 1, subject: "a", status: "pending" });
  s.commit("A", a);
  expect(s.get("B").tasks).toHaveLength(0);
  expect(s.get("A").tasks).toHaveLength(1);
  s.evict("A");
  expect(s.get("A").tasks).toHaveLength(0);
});

it("前台指针决定 renderState", () => {
  const s = createBoardStore();
  const a = emptyBoard(); a.tasks.push({ id: 1, subject: "a", status: "pending" });
  s.commit("A", a); s.setForeground("A");
  expect(s.renderState().tasks).toHaveLength(1);
  expect(s.foreground()).toBe("A");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/board/selectors.test.ts tests/board/replay.test.ts tests/board/store.test.ts`
Expected: FAIL — 三个模块不存在

- [ ] **Step 3: 实现 selectors**

```ts
// src/board/selectors.ts
import type { BoardState, Task } from "./types.js";

const settled = (s: Task["status"]) => s === "completed" || s === "deleted";

export const wipCount = (state: BoardState): number =>
  state.tasks.filter((t) => t.status === "in_progress").length;

export function selectNext(state: BoardState, wipLimit: number, capacityFull: boolean): Task | undefined {
  if (capacityFull || wipCount(state) >= wipLimit) return undefined;
  return state.tasks
    .filter((t) => t.status === "pending" && !t.park && !t.defer
      && (t.blockedBy ?? []).every((id) => { const d = state.tasks.find((x) => x.id === id); return d !== undefined && settled(d.status); }))
    .sort((a, b) => a.id - b.id)[0];
}

export function completedSummary(state: BoardState) {
  const visible = state.tasks.filter((t) => t.status !== "deleted");
  const done = visible.filter((t) => t.status === "completed");
  const finals = done.flatMap((t) => (t.evidence ?? []).filter((e) => e.chainFinal));
  return {
    done: done.length,
    total: visible.length,
    allExit0: finals.every((e) => e.ok && e.exitCode === 0),
    fpUnknown: finals.filter((e) => e.fp === "unknown").length,
    reverified: finals.filter((e) => e.note?.includes("reverified")).length,
    verifyChanged: done.filter((t) => t.verifyChanged).length,
  };
}
```

- [ ] **Step 4: 实现 replay 与 store**

```ts
// src/board/replay.ts
import { emptyBoard, type BoardState, type Status, type Task } from "./types.js";

const STATUSES = new Set<Status>(["pending", "in_progress", "parked", "completed", "deleted"]);
const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isTask(v: unknown): v is Task {
  if (!isBag(v)) return false;
  return Number.isSafeInteger(v.id) && typeof v.subject === "string" && STATUSES.has(v.status as Status);
}

/** 宽松解码：只校验 id/subject/status，其余字段原样保留（超集兼容）。 */
export function decodeSnapshot(v: unknown): BoardState | undefined {
  if (!isBag(v) || !Array.isArray(v.tasks) || !v.tasks.every(isTask) || !Number.isSafeInteger(v.nextId)) return undefined;
  const c = isBag(v.counters) ? v.counters : {};
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    tasks: (v.tasks as Task[]).map((t) => ({ ...t, inProgressSince: t.inProgressSince ?? t.statusSince ?? 0 })),
    nextId: v.nextId as number,
    counters: { turnsUsed: num(c.turnsUsed), wakeWatermark: num(c.wakeWatermark), renudgeBudget: num(c.renudgeBudget) },
  };
}

export function replayBranch(entries: Iterable<unknown>): BoardState {
  let fromEntries: BoardState | undefined;
  let fromResults: BoardState | undefined;
  for (const raw of entries) {
    if (!isBag(raw)) continue;
    if (raw.type === "custom") {
      if (raw.customType === "rpiv-todo-state") fromEntries = decodeSnapshot(raw.data) ?? fromEntries;
      continue;
    }
    if (raw.type !== "message" || !isBag(raw.message)) continue;
    const m = raw.message;
    if (m.role === "toolResult" && m.toolName === "todo") fromResults = decodeSnapshot(m.details) ?? fromResults;
  }
  return fromEntries ?? fromResults ?? emptyBoard();
}
```

```ts
// src/board/store.ts
import { emptyBoard, type BoardState } from "./types.js";

export function createBoardStore() {
  const slots = new Map<string, BoardState>();
  let front = "";
  const clone = (s: BoardState): BoardState => ({ tasks: s.tasks.map((t) => ({ ...t })), nextId: s.nextId, counters: { ...s.counters } });
  return {
    get: (sid: string): BoardState => slots.get(sid) ?? emptyBoard(),
    commit: (sid: string, s: BoardState) => { slots.set(sid, clone(s)); },
    replace: (sid: string, s: BoardState) => { slots.set(sid, clone(s)); },
    evict: (sid: string) => { slots.delete(sid); if (front === sid) front = ""; },
    setForeground: (sid: string) => { front = sid; },
    foreground: () => front,
    renderState: (): BoardState => slots.get(front) ?? emptyBoard(),
  };
}
export type BoardStore = ReturnType<typeof createBoardStore>;
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/board/selectors.ts src/board/replay.ts src/board/store.ts tests
git commit -m "feat(vigil-todo): selectors、replay 迁移 fallback 与会话隔离 store"
```

---

### Task 6: lib 基础设施（原子写、字节尾读、终端清洗）

**Files:**
- Create: `src/lib/atomic.ts`, `src/lib/tail.ts`, `src/lib/sanitize.ts`
- Test: `tests/lib/atomic.test.ts`, `tests/lib/tail.test.ts`, `tests/lib/sanitize.test.ts`

**Interfaces:**
- Consumes: T1
- Produces:
  - `writeJsonAtomic(path: string, value: unknown): void`
  - `readJsonSafe<T>(path: string): { ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" }`
  - `quarantine(path: string): string | undefined`（改名为 `<path>.corrupt-<ts>`）
  - `tailLines(path: string, lines: number, maxBytes: number): string[]`
  - `sanitizeTerminalText(s: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/lib/atomic.test.ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { quarantine, readJsonSafe, writeJsonAtomic } from "../../src/lib/atomic.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-atomic-"));

it("写入后可读回，且不留 tmp 文件", () => {
  const p = join(dir(), "jobs.json");
  writeJsonAtomic(p, { jobs: [{ id: "a" }] });
  expect(readJsonSafe<{ jobs: unknown[] }>(p)).toEqual({ ok: true, value: { jobs: [{ id: "a" }] } });
  expect(existsSync(`${p}.tmp`)).toBe(false);
});

it("缺文件与损坏可区分（Review Focus 2）", () => {
  const d = dir();
  expect(readJsonSafe(join(d, "nope.json"))).toEqual({ ok: false, reason: "missing" });
  const p = join(d, "bad.json"); writeFileSync(p, "{not json");
  expect(readJsonSafe(p)).toEqual({ ok: false, reason: "corrupt" });
});

it("quarantine 保留原内容供排障（F12）", () => {
  const p = join(dir(), "bad.json"); writeFileSync(p, "{not json");
  const moved = quarantine(p);
  expect(moved).toBeDefined();
  expect(readFileSync(moved!, "utf8")).toBe("{not json");
  expect(existsSync(p)).toBe(false);
});
```

```ts
// tests/lib/tail.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tailLines } from "../../src/lib/tail.js";

it("只取末 N 行", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "a.log");
  writeFileSync(p, Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n"));
  expect(tailLines(p, 3, 8192)).toEqual(["line997", "line998", "line999"]);
});

it("大文件不整读：maxBytes 限制生效（Review Focus 4）", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "big.log");
  writeFileSync(p, "x".repeat(200_000) + "\nlast");
  const out = tailLines(p, 5, 64);
  expect(out.join("").length).toBeLessThanOrEqual(64);
  expect(out.at(-1)).toContain("last");
});

it("文件不存在返回空数组，不抛（Review Focus 4）", () => {
  expect(tailLines("/nonexistent/vigil.log", 20, 8192)).toEqual([]);
});
```

```ts
// tests/lib/sanitize.test.ts
import { expect, it } from "vitest";
import { sanitizeTerminalText } from "../../src/lib/sanitize.js";

it("清除 CSI/OSC、换行转空格、去 bidi", () => {
  expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
  expect(sanitizeTerminalText("a\nb\tc")).toBe("a b c");
  expect(sanitizeTerminalText("a\u202eb")).toBe("ab");
  expect(sanitizeTerminalText("\u001b]0;title\u0007x")).toBe("x");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/lib`
Expected: FAIL — 三个模块不存在

- [ ] **Step 3: 实现**

```ts
// src/lib/atomic.ts
import { closeSync, fsyncSync, openSync, renameSync, readFileSync, existsSync, writeFileSync } from "node:fs";

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function readJsonSafe<T>(path: string): { ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" } {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try { return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as T }; }
  catch { return { ok: false, reason: "corrupt" }; }
}

export function quarantine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const moved = `${path}.corrupt-${Date.now()}`;
  try { renameSync(path, moved); return moved; } catch { return undefined; }
}
```

```ts
// src/lib/tail.ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 从文件尾按字节读 ≤maxBytes，取末 lines 行；不整读大文件。 */
export function tailLines(path: string, lines: number, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    const parts = text.split("\n");
    if (len < size) parts.shift();               // 丢弃可能被截断的首行
    while (parts.length && parts.at(-1) === "") parts.pop();
    return parts.slice(-lines);
  } catch { return []; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}
```

```ts
// src/lib/sanitize.ts
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : ""))
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib tests/lib
git commit -m "feat(vigil-todo): 原子写、字节尾读与终端清洗"
```

---

### Task 7: 作业 sidecar store、GC 与损坏降级

**Files:**
- Create: `src/jobs/store.ts`
- Test: `tests/jobs/store.test.ts`

**Interfaces:**
- Consumes: T1 `Job`、T6 atomic
- Produces:
  - `projectHash(cwd: string): string`
  - `runDir(cwd: string): string`
  - `createJobStore(dir: string)` → `{ all(): Job[]; get(id): Job | undefined; put(job): void; save(): void; load(): { degraded: boolean; note?: string }; gc(ttlMs, now): void }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/jobs/store.test.ts
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createJobStore, projectHash, runDir } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-jobs-"));
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("projectHash 稳定且 runDir 在 /tmp/bg-run 下", () => {
  expect(projectHash("/a/b")).toBe(projectHash("/a/b"));
  expect(projectHash("/a/b")).not.toBe(projectHash("/a/c"));
  expect(runDir("/a/b")).toBe(`/tmp/bg-run/${projectHash("/a/b")}`);
});

it("put/save/load 往返", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("bg_a")); s.save();
  const t = createJobStore(d);
  expect(t.load().degraded).toBe(false);
  expect(t.get("bg_a")?.id).toBe("bg_a");
});

it("损坏时留档并从空开始（F12）", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), "{broken");
  const s = createJobStore(d);
  const r = s.load();
  expect(r.degraded).toBe(true);
  expect(s.all()).toHaveLength(0);
  expect(readdirSync(d).some((f) => f.startsWith("jobs.json.corrupt-"))).toBe(true);
});

it("jobs 非数组或单条缺字段视为损坏（Review Focus 2）", () => {
  const d = dir(); writeFileSync(join(d, "jobs.json"), JSON.stringify({ jobs: "x" }));
  expect(createJobStore(d).load().degraded).toBe(true);
  const d2 = dir(); writeFileSync(join(d2, "jobs.json"), JSON.stringify({ jobs: [{ id: "a" }] }));
  expect(createJobStore(d2).load().degraded).toBe(true);
});

it("GC 只清超 TTL 的终态作业，running 永不清", () => {
  const d = dir(); const s = createJobStore(d);
  s.put(job("old", { endedAt: 1 }));
  s.put(job("run", { status: "running", endedAt: null }));
  s.save();
  s.gc(1000, 10_000);
  expect(s.get("old")).toBeUndefined();
  expect(s.get("run")).toBeDefined();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/jobs/store.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/jobs/store.ts
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { quarantine, readJsonSafe, writeJsonAtomic } from "../lib/atomic.js";
import type { Job } from "./types.js";

export function projectHash(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export const runDir = (cwd: string): string => join("/tmp/bg-run", projectHash(cwd));

const isJob = (v: unknown): v is Job => {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return typeof j.id === "string" && typeof j.rootId === "string" && typeof j.command === "string"
    && typeof j.status === "string" && typeof j.attempt === "number";
};

export function createJobStore(dir: string) {
  const path = join(dir, "jobs.json");
  let jobs = new Map<string, Job>();
  const ensure = () => mkdirSync(dir, { recursive: true });
  return {
    all: (): Job[] => [...jobs.values()],
    get: (id: string) => jobs.get(id),
    put: (j: Job) => { jobs.set(j.id, { ...j }); },
    save: () => { ensure(); writeJsonAtomic(path, { jobs: [...jobs.values()] }); },
    load: (): { degraded: boolean; note?: string } => {
      ensure();
      const r = readJsonSafe<{ jobs?: unknown }>(path);
      if (r.ok === false) {
        if (r.reason === "missing") return { degraded: false };
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar 损坏，已留档 ${moved ?? "(未移动)"}，从空开始` };
      }
      const list = r.value?.jobs;
      if (!Array.isArray(list) || !list.every(isJob)) {
        const moved = quarantine(path);
        jobs = new Map();
        return { degraded: true, note: `sidecar 结构非法，已留档 ${moved ?? "(未移动)"}，从空开始` };
      }
      jobs = new Map(list.map((j) => [j.id, j]));
      return { degraded: false };
    },
    gc: (ttlMs: number, now: number) => {
      for (const j of [...jobs.values()]) {
        if (j.status === "running" || j.retryAt != null) continue;
        if (j.endedAt != null && now - j.endedAt >= ttlMs) {
          jobs.delete(j.id);
          try { unlinkSync(j.logPath); } catch { /* 日志可能已被删 */ }
        }
      }
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jobs/store.ts src/jobs/types.ts tests/jobs
git commit -m "feat(vigil-todo): 作业 sidecar store、GC 与损坏留档降级"
```

---

### Task 8: spawn 与监控（真实退出码、cwd、startStamp、事件优先）

**Files:**
- Create: `src/jobs/spawn.ts`, `src/jobs/monitor.ts`
- Test: `tests/jobs/spawn.test.ts`, `tests/jobs/monitor.test.ts`

**Interfaces:**
- Consumes: T1 `Job`、T7 `JobStore`
- Produces:
  - `SpawnRequest { command: string; label?: string; cwd: string; taskId?: number; sessionId?: string; rootId?: string; retryOf?: string; attempt?: number; staleReverifyOf?: string }`
  - `spawnJob(req, dir, now): { ok: true; job: Job } | { ok: false; error: string }`
  - `readStartStamp(pid: number): string | undefined`
  - `createMonitor()` → `{ watch(job, onExit): () => void; clearAll(): void; pending(): number }`
  - `recoverJobs(store, now): void`（进程已消失 ⇒ `exitCodeKnown:false`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/jobs/spawn.test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnJob } from "../../src/jobs/spawn.js";
import { createMonitor } from "../../src/jobs/monitor.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-spawn-"));

it("记录 cwd 与 startStamp，退出码真实（F48 基础）", async () => {
  const d = dir();
  const r = spawnJob({ command: "pwd", cwd: d }, d, 1);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.job.cwd).toBe(d);
  expect(r.job.exitCodeKnown).toBe(false);   // 尚未退出
  expect(r.job.rootId).toBe(r.job.id);
  const mon = createMonitor();
  const code = await new Promise<number | null>((res) => mon.watch(r.job, (j) => res(j.exitCode)));
  expect(code).toBe(0);
  expect(readFileSync(r.job.logPath, "utf8").trim()).toBe(d);
  mon.clearAll();
});

it("失败命令得到非零真实退出码", async () => {
  const d = dir();
  const r = spawnJob({ command: "exit 7", cwd: d }, d, 1);
  if (!r.ok) throw new Error(r.error);
  const mon = createMonitor();
  const j = await new Promise<typeof r.job>((res) => mon.watch(r.job, res));
  expect(j.exitCode).toBe(7);
  expect(j.exitCodeKnown).toBe(true);
  expect(j.status).toBe("failed");
  mon.clearAll();
});

it("空命令直接失败，不产生 job", () => {
  const d = dir();
  expect(spawnJob({ command: "   ", cwd: d }, d, 1).ok).toBe(false);
});
```

```ts
// tests/jobs/monitor.test.ts
import { expect, it } from "vitest";
import { createMonitor, recoverJobs } from "../../src/jobs/monitor.js";
import { createJobStore } from "../../src/jobs/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../../src/jobs/types.js";

const base = (o: Partial<Job> = {}): Job => ({
  id: "bg_a", label: "a", command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 999_999,
  status: "running", exitCode: null, exitCodeKnown: false, startedAt: 1, endedAt: null,
  fpVerdict: "unknown", interferers: [], overlapUnfinished: [], rootId: "bg_a", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("同一 job 的 exit 与 close 只回调一次（F31 / Review Focus 3）", async () => {
  const mon = createMonitor();
  let calls = 0;
  const j = base();
  const stop = mon.watch(j, () => { calls++; });
  mon.__emitForTest(j.id, 0);
  mon.__emitForTest(j.id, 0);
  stop();
  expect(calls).toBe(1);
  mon.clearAll();
});

it("恢复态不伪造退出码（F5）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-rec-")));
  s.put(base());
  recoverJobs(s, 1000);
  const j = s.get("bg_a")!;
  expect(j.exitCodeKnown).toBe(false);
  expect(j.exitCode).toBeNull();
  expect(j.status).toBe("failed");
  expect(j.endedAt).toBe(1000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/jobs/spawn.test.ts tests/jobs/monitor.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 spawn**

```ts
// src/jobs/spawn.ts
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./types.js";

export interface SpawnRequest {
  command: string; label?: string; cwd: string; taskId?: number; sessionId?: string;
  rootId?: string; retryOf?: string; attempt?: number; staleReverifyOf?: string;
}

export function readStartStamp(pid: number): string | undefined {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || undefined; }
  catch { return undefined; }
}

let seq = 0;
const newId = () => `bg_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function spawnJob(req: SpawnRequest, dir: string, now: number):
  { ok: true; job: Job } | { ok: false; error: string } {
  if (!req.command?.trim()) return { ok: false, error: "Command cannot be empty" };
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const logPath = join(dir, `${id}.log`);
  let fd: number;
  try { fd = openSync(logPath, "w"); } catch (e) { return { ok: false, error: `log file: ${String(e)}` }; }
  try {
    const child = spawn("sh", ["-c", req.command], { cwd: req.cwd, detached: true, stdio: ["ignore", fd, fd] });
    if (child.pid === undefined) return { ok: false, error: "spawn returned no pid" };
    const job: Job = {
      id, label: req.label?.trim() || req.command.trim().slice(0, 50), command: req.command,
      logPath, cwd: req.cwd, pid: child.pid, status: "running",
      exitCode: null, exitCodeKnown: false, startedAt: now, endedAt: null,
      startStamp: readStartStamp(child.pid),
      fpVerdict: "unknown", interferers: [], overlapUnfinished: [],
      rootId: req.rootId ?? id, retryOf: req.retryOf, attempt: req.attempt ?? 1,
      staleReverifyOf: req.staleReverifyOf,
      taskId: req.taskId, sessionId: req.sessionId,
      evidenceApplied: false, notifyState: "pending",
    };
    return { ok: true, job, ...({ child } as object) } as { ok: true; job: Job };
  } catch (e) { return { ok: false, error: `spawn failed: ${String(e)}` }; }
  finally { try { closeSync(fd); } catch { /* ignore */ } }
}
```

注：`spawnJob` 需要把 `child` 交给 monitor。实现时把返回值定为 `{ ok: true; job: Job; child: ChildProcess }`，测试只读 `job`；上面的 `as` 写法请改为显式接口：

```ts
export type SpawnResult = { ok: true; job: Job; child: import("node:child_process").ChildProcess } | { ok: false; error: string };
```

- [ ] **Step 4: 实现 monitor**

```ts
// src/jobs/monitor.ts
import type { ChildProcess } from "node:child_process";
import type { Job } from "./types.js";
import type { JobStore } from "./store.js";

export function createMonitor() {
  const fired = new Set<string>();
  const stops = new Map<string, () => void>();
  const handlers = new Map<string, (j: Job) => void>();
  const jobs = new Map<string, Job>();

  const emit = (id: string, code: number | null, signal?: string | null) => {
    if (fired.has(id)) return;                       // F31：exit/close 只生效一次
    fired.add(id);
    const j = jobs.get(id);
    if (!j) return;
    j.exitCode = code;
    j.signal = signal ?? null;
    j.exitCodeKnown = code !== null;
    j.endedAt = Date.now();
    j.status = j.kill ? "killed" : code === 0 ? "completed" : "failed";
    stops.get(id)?.();
    stops.delete(id);
    handlers.get(id)?.(j);
  };

  return {
    watch(job: Job, onExit: (j: Job) => void, child?: ChildProcess): () => void {
      jobs.set(job.id, job); handlers.set(job.id, onExit);
      if (child) {
        const onErr = () => emit(job.id, null);
        const onClose = (code: number | null, sig: string | null) => { child.unref(); emit(job.id, code, sig); };
        child.once("error", onErr);
        child.once("close", onClose);
        const stop = () => { child.off("error", onErr); child.off("close", onClose); };
        stops.set(job.id, stop);
        return stop;
      }
      const timer = setInterval(() => {
        try { process.kill(job.pid, 0); } catch { emit(job.id, null); }
      }, 3000);
      timer.unref?.();
      const stop = () => clearInterval(timer);
      stops.set(job.id, stop);
      return stop;
    },
    clearAll() { for (const s of stops.values()) s(); stops.clear(); handlers.clear(); jobs.clear(); },
    pending: () => stops.size,
    __emitForTest: (id: string, code: number | null) => emit(id, code),
  };
}

/** 重启恢复：进程已消失 ⇒ 不猜退出码（规格 §10.1）。 */
export function recoverJobs(store: JobStore, now: number): void {
  for (const j of store.all()) {
    if (j.status !== "running") continue;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch { alive = false; }
    if (alive && j.startStamp) {
      // pid 复用防护：startStamp 不一致视为已消失
      alive = false;
    }
    if (alive) continue;
    store.put({ ...j, status: "failed", exitCode: null, exitCodeKnown: false, endedAt: now });
  }
}
```

实现注：`recoverJobs` 中若 `alive && startStamp`，需调用 `readStartStamp(j.pid)` 与 `j.startStamp` 比对，一致才保留 running；不一致才判消失。测试用不存在的 pid 覆盖消失分支。

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（含真实子进程用例）

- [ ] **Step 6: Commit**

```bash
git add src/jobs/spawn.ts src/jobs/monitor.ts tests/jobs
git commit -m "feat(vigil-todo): spawn 记录 cwd/startStamp，监控事件优先且退出码不伪造"
```

---

### Task 9: 重试链派生上限与容量准入（摘己规则）

**Files:**
- Create: `src/jobs/chain.ts`, `src/jobs/capacity.ts`
- Test: `tests/jobs/chain.test.ts`, `tests/jobs/capacity.test.ts`

**Interfaces:**
- Consumes: T1 `Job`、T7 `JobStore`
- Produces:
  - `chainJobs(store, rootId): Job[]`
  - `isReverifyBranch(job, store): boolean`
  - `canRetry(job, store, retries): boolean`
  - `canReverify(job, store, staleReverify): boolean`
  - `nextAttempt(job): number`
  - `retryDelayMs(attempt, delays): number`
  - `chainTerminated(store, rootId): boolean`
  - `reservedSlots(store): number`
  - `admitNewSpawn(store, max): boolean`
  - `admitRespawn(store, rootId, max): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// tests/jobs/chain.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canRetry, canReverify, chainJobs, chainTerminated, isReverifyBranch, retryDelayMs } from "../../src/jobs/chain.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-chain-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("退避间隔按 attempt 取，越界取最后一档", () => {
  const d = [0, 30_000, 120_000];
  expect(retryDelayMs(1, d)).toBe(0);
  expect(retryDelayMs(2, d)).toBe(30_000);
  expect(retryDelayMs(3, d)).toBe(120_000);
  expect(retryDelayMs(9, d)).toBe(120_000);
});

it("attempt 上限含重验分支内的失败重试（F67）", () => {
  const s = store();
  s.put(j("a1", { attempt: 1 }));
  s.put(j("r1", { attempt: 1, retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  s.put(j("r2", { attempt: 2, retryOf: "r1", status: "failed" }));
  s.put(j("r3", { attempt: 3, retryOf: "r2", status: "failed" }));
  s.put(j("r4", { attempt: 4, retryOf: "r3", status: "failed" }));
  expect(canRetry(s.get("r4")!, s, 3)).toBe(false);
  expect(chainJobs(s, "R")).toHaveLength(5);
});

it("重验分支后代不得再触发重验（F67）", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  s.put(j("r1", { retryOf: "a1", staleReverifyOf: "a1", status: "failed" }));
  s.put(j("r2", { attempt: 2, retryOf: "r1", status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(isReverifyBranch(s.get("r2")!, s)).toBe(true);
  expect(canReverify(s.get("r2")!, s, 1)).toBe(false);
  expect(canReverify(s.get("a1")!, s, 1)).toBe(false);   // 额度已用
});

it("首次 stale 且额度未用可重验（F64）", () => {
  const s = store();
  s.put(j("a1", { status: "completed", exitCode: 0, fpVerdict: "stale" }));
  expect(canReverify(s.get("a1")!, s, 1)).toBe(true);
});

it("chainTerminated 是派生判定：running / retryAt / pendingReverify 任一存在即未终结", () => {
  const s = store();
  s.put(j("R", { status: "running", endedAt: null }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", retryAt: 999 }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", retryAt: undefined, pendingReverify: true }));
  expect(chainTerminated(s, "R")).toBe(false);
  s.put(j("R", { status: "failed", pendingReverify: false }));
  expect(chainTerminated(s, "R")).toBe(true);
});

it("root 记录不存在时视为已终结（F34 孤儿）", () => {
  expect(chainTerminated(store(), "missing")).toBe(true);
});
```

```ts
// tests/jobs/capacity.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { admitNewSpawn, admitRespawn, reservedSlots } from "../../src/jobs/capacity.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("reservedSlots 是派生值，等于 retryAt 非空的条数（F46）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  expect(reservedSlots(s)).toBe(10);
});

it("10 条链同时退避时每条 respawn 都被准入（F60 自锁）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  for (let i = 0; i < 10; i++) expect(admitRespawn(s, `c${i}`, 10)).toBe(true);
});

it("新 spawn 受 running + reserved 限制（F47）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  expect(admitNewSpawn(s, 10)).toBe(false);
  expect(admitNewSpawn(s, 11)).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/jobs/chain.test.ts tests/jobs/capacity.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 chain**

```ts
// src/jobs/chain.ts
import type { JobStore } from "./store.js";
import type { Job } from "./types.js";

export const chainJobs = (store: JobStore, rootId: string): Job[] =>
  store.all().filter((j) => j.rootId === rootId);

/** 沿 retryOf 上溯，任一祖先（含自身）带 staleReverifyOf 即属重验分支。 */
export function isReverifyBranch(job: Job, store: JobStore): boolean {
  let cur: Job | undefined = job;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.staleReverifyOf) return true;
    cur = cur.retryOf ? store.get(cur.retryOf) : undefined;
  }
  return false;
}

export const nextAttempt = (job: Job): number => job.attempt + 1;
export const retryDelayMs = (attempt: number, delays: number[]): number =>
  delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 0;

/** attempt 上限 = 1 + retries；含重验分支内的失败重试。 */
export const canRetry = (job: Job, _store: JobStore, retries: number): boolean =>
  job.attempt < 1 + retries;

/** 重验额度落链上；重验分支后代永不再触发。 */
export function canReverify(job: Job, store: JobStore, staleReverify: number): boolean {
  if (staleReverify <= 0) return false;
  if (isReverifyBranch(job, store)) return false;
  const used = chainJobs(store, job.rootId).filter((j) => j.staleReverifyOf != null).length;
  return used < staleReverify;
}

/** 派生终结判定（规格 §4.5）：无 running、无 retryAt、无待重验。 */
export function chainTerminated(store: JobStore, rootId: string): boolean {
  const list = chainJobs(store, rootId);
  if (list.length === 0) return true;                       // 孤儿 root
  const root = store.get(rootId);
  if (root?.pendingReverify) return false;
  return list.every((j) => j.status !== "running" && j.retryAt == null);
}
```

- [ ] **Step 4: 实现 capacity**

```ts
// src/jobs/capacity.ts
import type { JobStore } from "./store.js";

export const reservedSlots = (store: JobStore): number =>
  store.all().filter((j) => j.retryAt != null).length;

const runningCount = (store: JobStore): number =>
  store.all().filter((j) => j.status === "running").length;

export const admitNewSpawn = (store: JobStore, max: number): boolean =>
  runningCount(store) + reservedSlots(store) < max;

/** respawn 先摘下自己的 retryAt，再判 running < max（规格 §7.2 自锁修复）。 */
export const admitRespawn = (store: JobStore, rootId: string, max: number): boolean => {
  const running = store.all().filter((j) => j.status === "running" && j.rootId !== rootId).length;
  return running < max;
};
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/jobs/chain.ts src/jobs/capacity.ts tests/jobs
git commit -m "feat(vigil-todo): 链级派生上限、重验继承与摘己容量准入"
```

---

### Task 10: 中止链、O_EXCL 认领与会话心跳

**Files:**
- Create: `src/jobs/kill.ts`, `src/jobs/claims.ts`, `src/jobs/heartbeat.ts`
- Test: `tests/jobs/kill.test.ts`, `tests/jobs/claims.test.ts`, `tests/jobs/heartbeat.test.ts`

**Interfaces:**
- Consumes: T7 `JobStore`、T9 `chainJobs`
- Produces:
  - `requestKill(store, idOrRoot, by: "self"|"external", now): { killed: string[]; cancelledBackoff: string[] }`
  - `escalate(pid, timeoutMs): Promise<void>`（SIGTERM→SIGKILL，进程组优先）
  - `claim(dir, rootId, kind: "adopt"|"respawn", me, now): boolean`
  - `release(dir, rootId, kind): void`
  - `takeoverStale(dir, rootId, kind, me, isStale): boolean`
  - `writeHeartbeat(dir, sessionId, pid, now): void`
  - `readLiveness(dir, sessionId, now, staleMs, hungMs): "active"|"inactive"|"suspect"`
  - `removeHeartbeat(dir, sessionId): void`

- [ ] **Step 1: 写失败测试**

```ts
// tests/jobs/kill.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { requestKill } from "../../src/jobs/kill.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 999_999,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("按 rootId 取消整链：清 retryAt 并记 requestedBy（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-kill-")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  const r = requestKill(s, "R", "self", 1000);
  expect(r.cancelledBackoff.sort()).toEqual(["R", "R2"]);
  expect(s.get("R")?.retryAt).toBeUndefined();
  expect(s.get("R")?.kill).toEqual({ requestedBy: "self", at: 1000 });
});

it("按链上任意 id 也能定位 root（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-kill-")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  expect(requestKill(s, "R2", "external", 1000).cancelledBackoff).toHaveLength(2);
});

it("未知 id 返回空结果，不抛", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-kill-")));
  expect(requestKill(s, "nope", "self", 1)).toEqual({ killed: [], cancelledBackoff: [] });
});
```

```ts
// tests/jobs/claims.test.ts
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claim, release, takeoverStale } from "../../src/jobs/claims.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-claim-"));

it("O_EXCL：同一 claim 只有一个赢家（F101）", () => {
  const d = dir();
  expect(claim(d, "R", "adopt", "A", 1)).toBe(true);
  expect(claim(d, "R", "adopt", "B", 1)).toBe(false);
});

it("adopt 与 respawn 互不覆盖", () => {
  const d = dir();
  expect(claim(d, "R", "adopt", "A", 1)).toBe(true);
  expect(claim(d, "R", "respawn", "A", 1)).toBe(true);
});

it("release 后可再认领", () => {
  const d = dir();
  claim(d, "R", "adopt", "A", 1);
  release(d, "R", "adopt");
  expect(claim(d, "R", "adopt", "B", 2)).toBe(true);
});

it("过期收回用 rename 竞争，只有一个获重建权（F103）", () => {
  const d = dir();
  claim(d, "R", "adopt", "A", 1);
  const a = takeoverStale(d, "R", "adopt", "A", () => true);
  const b = takeoverStale(d, "R", "adopt", "B", () => true);
  expect([a, b].filter(Boolean)).toHaveLength(1);
});

it("claim 不存在时 takeover 返回 false，不抛（Review Focus 4）", () => {
  expect(takeoverStale(dir(), "R", "adopt", "A", () => true)).toBe(false);
});
```

```ts
// tests/jobs/heartbeat.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readLiveness, removeHeartbeat, writeHeartbeat } from "../../src/jobs/heartbeat.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-hb-"));

it("新鲜心跳判活跃", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 1000, 15_000, 600_000)).toBe("active");
});

it("心跳过期但 pid 存活且未超挂死阈值 → 仍活跃（合盖场景）", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 20_000, 15_000, 600_000)).toBe("active");
});

it("pid 存活但停更超挂死阈值 → suspect（F98）", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 700_000, 15_000, 600_000)).toBe("suspect");
});

it("pid 已死且心跳过期 → inactive（F96）", () => {
  const d = dir();
  writeHeartbeat(d, "S", 999_999, 1000);
  expect(readLiveness(d, "S", 30_000, 15_000, 600_000)).toBe("inactive");
});

it("无心跳文件 → inactive；remove 后同样", () => {
  const d = dir();
  expect(readLiveness(d, "S", 1, 15_000, 600_000)).toBe("inactive");
  writeHeartbeat(d, "S", process.pid, 1);
  removeHeartbeat(d, "S");
  expect(readLiveness(d, "S", 1, 15_000, 600_000)).toBe("inactive");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/jobs/kill.test.ts tests/jobs/claims.test.ts tests/jobs/heartbeat.test.ts`
Expected: FAIL — 三个模块不存在

- [ ] **Step 3: 实现 kill**

```ts
// src/jobs/kill.ts
import { chainJobs } from "./chain.js";
import type { JobStore } from "./store.js";

export function requestKill(store: JobStore, idOrRoot: string, by: "self" | "external", now: number) {
  const target = store.get(idOrRoot);
  if (!target) return { killed: [] as string[], cancelledBackoff: [] as string[] };
  const list = chainJobs(store, target.rootId);
  const killed: string[] = [];
  const cancelledBackoff: string[] = [];
  for (const j of list) {
    const next = { ...j, kill: { requestedBy: by, at: now } };
    if (next.retryAt != null) { delete next.retryAt; cancelledBackoff.push(j.id); }
    if (j.status === "running") killed.push(j.id);
    store.put(next);
  }
  return { killed, cancelledBackoff };
}

/** SIGTERM → 等 timeoutMs → SIGKILL；进程组优先。 */
export async function escalate(pid: number, timeoutMs: number): Promise<void> {
  const send = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); return; } catch { /* 无进程组 */ }
    try { process.kill(pid, sig); } catch { /* 已退出 */ }
  };
  send("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  send("SIGKILL");
}
```

- [ ] **Step 4: 实现 claims 与 heartbeat**

```ts
// src/jobs/claims.ts
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Kind = "adopt" | "respawn";
const pathOf = (dir: string, rootId: string, kind: Kind) => join(dir, "claims", `${rootId}.${kind}.json`);

/** O_EXCL 原子创建：已存在即输者。 */
export function claim(dir: string, rootId: string, kind: Kind, me: string, now: number): boolean {
  const p = pathOf(dir, rootId, kind);
  mkdirSync(join(dir, "claims"), { recursive: true });
  let fd: number;
  try { fd = openSync(p, "wx"); } catch { return false; }
  try { writeFileSync(fd, JSON.stringify({ by: me, at: now, pid: process.pid })); } finally { closeSync(fd); }
  return true;
}

export function release(dir: string, rootId: string, kind: Kind): void {
  try { unlinkSync(pathOf(dir, rootId, kind)); } catch { /* 已不存在 */ }
}

/** 过期收回：rename 原子竞争，成功者获重建权（规格 §7.1.1-B）。 */
export function takeoverStale(dir: string, rootId: string, kind: Kind, me: string, isStale: () => boolean): boolean {
  const p = pathOf(dir, rootId, kind);
  if (!isStale()) return false;
  try { renameSync(p, `${p}.stale.${me}`); } catch { return false; }
  return claim(dir, rootId, kind, me, Date.now());
}
```

```ts
// src/jobs/heartbeat.ts
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic.js";
import { readStartStamp } from "./spawn.js";

interface Heartbeat { pid: number; startStamp?: string; heartbeatAt: number }
const pathOf = (dir: string, sid: string) => join(dir, "sessions", `${sid}.json`);

export function writeHeartbeat(dir: string, sessionId: string, pid: number, now: number): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeJsonAtomic(pathOf(dir, sessionId), { pid, startStamp: readStartStamp(pid), heartbeatAt: now } satisfies Heartbeat);
}

export function readLiveness(dir: string, sessionId: string, now: number, staleMs: number, hungMs: number):
  "active" | "inactive" | "suspect" {
  const r = readJsonSafe<Heartbeat>(pathOf(dir, sessionId));
  if (r.ok === false) return "inactive";
  const hb = r.value;
  const fresh = now - hb.heartbeatAt < staleMs;
  if (fresh) return "active";
  let alive = false;
  try { process.kill(hb.pid, 0); alive = true; } catch { alive = false; }
  if (alive && hb.startStamp && readStartStamp(hb.pid) !== hb.startStamp) alive = false;  // pid 复用
  if (!alive) return "inactive";
  return now - hb.heartbeatAt > hungMs ? "suspect" : "active";
}

export function removeHeartbeat(dir: string, sessionId: string): void {
  try { unlinkSync(pathOf(dir, sessionId)); } catch { /* 已不存在 */ }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/jobs/kill.ts src/jobs/claims.ts src/jobs/heartbeat.ts tests/jobs
git commit -m "feat(vigil-todo): 中止链、O_EXCL 认领与 rename 收回、会话心跳"
```

---

### Task 11: 指纹采集与延迟三态判定（两集合分离）

**Files:**
- Create: `src/lib/fingerprint.ts`
- Test: `tests/lib/fingerprint.test.ts`

**Interfaces:**
- Consumes: T1 `Job`/`FpVerdict`、T7 `JobStore`
- Produces:
  - `collectFingerprint(cwd: string): string | undefined`
  - `classifyOverlap(job, store): { interferers: string[]; overlapUnfinished: string[] }`
  - `verdictAt(job, store): FpVerdict`
  - `fpReason(job): string`

- [ ] **Step 1: 写失败测试**

```ts
// tests/lib/fingerprint.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyOverlap, collectFingerprint, fpReason, verdictAt } from "../../src/lib/fingerprint.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const gitDir = () => {
  const d = mkdtempSync(join(tmpdir(), "vigil-fp-"));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d });
  writeFileSync(join(d, "a.txt"), "a");
  execFileSync("git", ["add", "."], { cwd: d });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: d });
  return d;
};
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 100, endedAt: 200,
  fpStart: "A", fpEnd: "A", fpVerdict: "unknown", interferers: [], overlapUnfinished: [],
  rootId: id, attempt: 1, evidenceApplied: false, notifyState: "pending", ...o,
});

it("git 目录可采集；改动后指纹变化", () => {
  const d = gitDir();
  const a = collectFingerprint(d);
  expect(a).toBeDefined();
  writeFileSync(join(d, "a.txt"), "b");
  expect(collectFingerprint(d)).not.toBe(a);
});

it("非 git 目录返回 undefined（F35）", () => {
  expect(collectFingerprint(mkdtempSync(join(tmpdir(), "vigil-nogit-")))).toBeUndefined();
});

it("指纹未变 → fresh", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A"); s.put(a);
  expect(verdictAt(a, s)).toBe("fresh");
});

it("独占期间变了 → stale（F64 前置）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B" }); s.put(a);
  expect(verdictAt(a, s)).toBe("stale");
});

it("同 taskId 的并行作业不算干扰（F56）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 7, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "B" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
  expect(verdictAt(a, s)).toBe("stale");
});

it("并发作业期间 fpStart===fpEnd 不算干扰（F57）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "A" }));
  expect(classifyOverlap(a, s).interferers).toEqual([]);
});

it("有写入的并发作业 → unknown（F58）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  expect(classifyOverlap(a, s).interferers).toEqual(["B"]);
  expect(verdictAt(a, s)).toBe("unknown");
  expect(fpReason(a)).toContain("无法归因");
});

it("并发作业缺 fpEnd → overlapUnfinished ⇒ unknown（F63/F75）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  const c = classifyOverlap(a, s);
  expect(c.overlapUnfinished).toEqual(["B"]);
  expect(c.interferers).toEqual([]);
  expect(verdictAt(a, s)).toBe("unknown");
});

it("两类同时存在仍是 unknown，不误判 stale（F79）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpEnd: "B", taskId: 7 }); s.put(a);
  s.put(j("B", { taskId: 8, startedAt: 150, endedAt: 250, fpStart: "A", fpEnd: "C" }));
  s.put(j("C", { taskId: 9, startedAt: 150, endedAt: null, status: "running", fpEnd: undefined }));
  expect(verdictAt(a, s)).toBe("unknown");
});

it("采集失败（fpStart/fpEnd 缺失）→ unknown，不当 fresh（Review Focus 4）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fps-")));
  const a = j("A", { fpStart: undefined, fpEnd: undefined }); s.put(a);
  expect(verdictAt(a, s)).toBe("unknown");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/lib/fingerprint.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/lib/fingerprint.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { FpVerdict } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { Job } from "../jobs/types.js";

/** HEAD + tracked 工作区状态哈希；非 git 或失败返回 undefined（已知盲区：ignored 文件不计）。 */
export function collectFingerprint(cwd: string): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return createHash("sha1").update(head.trim()).update("\n").update(status).digest("hex").slice(0, 12);
  } catch { return undefined; }
}

const overlaps = (a: Job, b: Job): boolean =>
  a.id !== b.id && a.cwd === b.cwd && a.taskId !== b.taskId
  && b.startedAt <= (a.endedAt ?? Number.MAX_SAFE_INTEGER)
  && (b.endedAt ?? Number.MAX_SAFE_INTEGER) >= a.startedAt;

/** 两集合必须分开：有写入 vs 无法判定（规格 §5.2）。 */
export function classifyOverlap(job: Job, store: JobStore) {
  const interferers: string[] = [];
  const overlapUnfinished: string[] = [];
  for (const other of store.all()) {
    if (!overlaps(job, other)) continue;
    if (other.fpEnd === undefined) overlapUnfinished.push(other.id);
    else if (other.fpStart !== other.fpEnd) interferers.push(other.id);
  }
  return { interferers, overlapUnfinished };
}

/** 回填时才计算；两集合皆空且指纹变了才 stale。 */
export function verdictAt(job: Job, store: JobStore): FpVerdict {
  if (job.fpStart === undefined || job.fpEnd === undefined) return "unknown";
  if (job.fpStart === job.fpEnd) return "fresh";
  const { interferers, overlapUnfinished } = classifyOverlap(job, store);
  return interferers.length === 0 && overlapUnfinished.length === 0 ? "stale" : "unknown";
}

export function fpReason(job: Job): string {
  if (job.fpVerdict === "fresh") return "fp:fresh";
  if (job.fpVerdict === "stale") return "fp:stale（独占期间工作区变过）";
  if (job.overlapUnfinished.length > 0) return `fp:unknown（${job.overlapUnfinished.join(",")} 无法判定：未结束/结果未知）`;
  if (job.interferers.length > 0) return `fp:unknown（${job.interferers.join(",")} 期间有写入，无法归因）`;
  return "fp:n/a（非 git 或采集失败）";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（11 例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/fingerprint.ts tests/lib/fingerprint.test.ts
git commit -m "feat(vigil-todo): 指纹采集与延迟三态判定，两集合分离"
```

---

### Task 12: 回填（autofill）——证据、人工优先与 stale 自动重验

**Files:**
- Create: `src/bind/autofill.ts`
- Test: `tests/bind/autofill.test.ts`

**Interfaces:**
- Consumes: T1–T11
- Produces:
  - `AutofillDeps { boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string; respawn(req: SpawnRequest): { ok: boolean; error?: string }; notify(note: string): void }`
  - `autofillJob(jobId: string, deps: AutofillDeps): { action: "completed"|"parked"|"retry"|"reverify"|"recorded"; reason?: string }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/bind/autofill.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autofillJob, type AutofillDeps } from "../../src/bind/autofill.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard, type Task } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let deps: AutofillDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
const task = (o: Partial<Task> = {}): Task => ({ id: 1, subject: "t", status: "in_progress", inProgressSince: 50, jobs: ["A"], ...o });
const job = (o: Partial<Job> = {}): Job => ({
  id: "A", label: "a", command: "npm test", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 100, endedAt: 200,
  fpStart: "X", fpEnd: "X", fpVerdict: "unknown", interferers: [], overlapUnfinished: [],
  rootId: "A", attempt: 1, taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-af-")));
  const b = emptyBoard(); b.tasks = [task()]; b.nextId = 2; boards.commit("S", b);
  deps = { boards, jobs, cfg: DEFAULTS, now: 300, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {} };
});

describe("成功路径", () => {
  it("fresh + 证据合格 → 自动 completed（F4）", () => {
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("completed");
    expect(boards.get("S").tasks[0].status).toBe("completed");
  });
  it("unknown 也自动完成（F58）", () => {
    jobs.put(job({ fpEnd: "Y", interferers: ["B"] }));
    jobs.put(job({ id: "B", taskId: 2, rootId: "B", startedAt: 150, endedAt: 250, fpStart: "X", fpEnd: "Z" }));
    expect(autofillJob("A", deps).action).toBe("completed");
  });
  it("重复调用只写一条证据（F31）", () => {
    jobs.put(job());
    autofillJob("A", deps); autofillJob("A", deps);
    expect(boards.get("S").tasks[0].evidence).toHaveLength(1);
  });
});

describe("stale 自动重验", () => {
  it("首次 stale 触发重验，不 park 不完成（F64）", () => {
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("reverify");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
    expect(jobs.get("A")?.pendingReverify).toBe(true);
  });
  it("有 verify.command 时重验跑它（F68）", () => {
    const b = boards.get("S"); b.tasks[0].verify = { kind: "command", command: "npm run check" }; boards.commit("S", b);
    let cmd = "";
    deps.respawn = (req) => { cmd = req.command; return { ok: true }; };
    jobs.put(job({ fpEnd: "Y" }));
    autofillJob("A", deps);
    expect(cmd).toBe("npm run check");
  });
  it("重验额度用尽 → parked（F20）", () => {
    jobs.put(job({ fpEnd: "Y" }));
    jobs.put(job({ id: "R1", rootId: "A", retryOf: "A", staleReverifyOf: "A", fpEnd: "Z" }));
    expect(autofillJob("A", { ...deps, now: 400 }).action).toBe("parked");
  });
  it("重验遇 capacity 拒 → parked（F69）", () => {
    deps.respawn = () => ({ ok: false, error: "capacity" });
    jobs.put(job({ fpEnd: "Y" }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("parked");
    expect(r.reason).toContain("槽位");
  });
  it("verifyChanged 的任务禁止自动完成（F53）", () => {
    const b = boards.get("S"); b.tasks[0].verifyChanged = true; boards.commit("S", b);
    jobs.put(job());
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].status).toBe("in_progress");
  });
});

describe("失败与终结", () => {
  it("失败未用尽 → retry 且写 lastFailure（F16）", () => {
    jobs.put(job({ status: "failed", exitCode: 1 }));
    const r = autofillJob("A", deps);
    expect(r.action).toBe("retry");
    expect(boards.get("S").tasks[0].lastFailure?.exitCode).toBe(1);
  });
  it("失败用尽 → parked 且有 chainFinal 证据（F72/F74）", () => {
    jobs.put(job({ status: "failed", exitCode: 1, attempt: 4 }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
  it("killed 不写 lastFailure（F50/F73）", () => {
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "external", at: 250 } }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].lastFailure).toBeUndefined();
  });
  it("恢复态 known:false → parked，不 completed（F5）", () => {
    jobs.put(job({ status: "failed", exitCode: null, exitCodeKnown: false }));
    expect(autofillJob("A", deps).action).toBe("parked");
    expect(boards.get("S").tasks[0].status).toBe("parked");
  });
});

describe("人工优先（R2-5）", () => {
  it("任务已 parked 时只记证据，不覆盖 reason（F49）", () => {
    const b = boards.get("S");
    b.tasks[0].status = "parked";
    b.tasks[0].park = { reason: "我要的理由", at: 250, from: "in_progress" };
    boards.commit("S", b);
    jobs.put(job({ status: "killed", exitCode: null, exitCodeKnown: false, kill: { requestedBy: "self", at: 260 } }));
    expect(autofillJob("A", deps).action).toBe("recorded");
    expect(boards.get("S").tasks[0].park?.reason).toBe("我要的理由");
  });
  it("非 owner 会话不写别人的 board（F84）", () => {
    jobs.put(job({ sessionId: "OTHER" }));
    expect(autofillJob("A", { ...deps, sessionId: "S" }).action).toBe("recorded");
    expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/bind/autofill.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/bind/autofill.ts
import { appendEvidence, completionGate, recordFailure } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import type { Evidence, Task } from "../board/types.js";
import { canRetry, canReverify, chainTerminated, retryDelayMs } from "../jobs/chain.js";
import type { JobStore } from "../jobs/store.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { VigilConfig } from "../lib/config.js";
import { verdictAt } from "../lib/fingerprint.js";
import { tailLines } from "../lib/tail.js";

export interface AutofillDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string;
  respawn(req: SpawnRequest): { ok: boolean; error?: string };
  notify(note: string): void;
}
export type AutofillAction = "completed" | "parked" | "retry" | "reverify" | "recorded";

const factsOf = (jobs: JobStore) => ({
  hasRunning: (taskId: number) => jobs.all().some((j) => j.taskId === taskId && j.status === "running"),
  hasBackoff: (taskId: number) => jobs.all().some((j) => j.taskId === taskId && j.retryAt != null),
  startedAt: (ref: string) => jobs.get(ref)?.startedAt,
  exists: (id: string) => jobs.get(id) !== undefined,
});

export function autofillJob(jobId: string, d: AutofillDeps): { action: AutofillAction; reason?: string } {
  const job = d.jobs.get(jobId);
  if (!job) return { action: "recorded" };
  const board = d.boards.get(d.sessionId);
  const idx = board.tasks.findIndex((t) => t.id === job.taskId);
  const task: Task | undefined = idx >= 0 ? { ...board.tasks[idx] } : undefined;

  // 非 owner / 无绑定任务：只落 job 侧，不碰 board（铁律）
  if (!task || job.sessionId !== d.sessionId) return { action: "recorded" };

  const fp = verdictAt(job, d.jobs);
  const cls = classifyFp(job, fp);
  d.jobs.put({ ...job, fpVerdict: fp, ...cls });

  const ok = job.exitCodeKnown && job.exitCode === 0 && job.status === "completed";
  const ev: Evidence = {
    ok, kind: "job", origin: "async", chainFinal: false, at: d.now,
    exitCode: job.exitCode, known: job.exitCodeKnown, fp, ref: job.id,
    note: ok ? undefined : tailLines(job.logPath, 1, d.cfg.maxTailBytes)[0],
  };

  const humanFirst = task.status !== "in_progress";
  const commit = (mut: (t: Task) => void, action: AutofillAction, reason?: string) => {
    const next = { ...task };
    appendEvidence(next, ev);
    mut(next);
    const tasks = [...board.tasks]; tasks[idx] = next;
    d.boards.commit(d.sessionId, { ...board, tasks });
    return { action, reason };
  };

  if (job.status === "failed" && job.exitCodeKnown && job.exitCode !== 0) {
    recordFailure(task, { exitCode: job.exitCode, ref: job.id, at: d.now, note: ev.note });
    if (canRetry(job, d.jobs, d.cfg.retries)) {
      const delay = retryDelayMs(job.attempt, d.cfg.retryDelaysMs);
      d.jobs.put({ ...d.jobs.get(job.id)!, retryAt: d.now + delay });
      return commit(() => {}, "retry");
    }
    const reason = `${job.attempt} 次均失败${ev.note ? ` · ${ev.note}` : ""}`;
    return commit((t) => { t.status = "parked"; t.statusSince = d.now; t.park = { reason, at: d.now, from: "in_progress" }; }, "parked", reason);
  }

  if (job.status === "killed" || !job.exitCodeKnown) {
    const reason = job.status === "killed" ? "killed" : "退出码未知，需重验";
    if (humanFirst) return commit(() => {}, "recorded");
    return commit((t) => { t.status = "parked"; t.statusSince = d.now; t.park = { reason, at: d.now, from: "in_progress" }; }, "parked", reason);
  }

  // ok === true
  if (fp === "stale") {
    if (canReverify(job, d.jobs, d.cfg.staleReverify)) {
      const command = task.verify?.command ?? job.command;
      const r = d.respawn({
        command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
        rootId: job.rootId, retryOf: job.id, attempt: job.attempt, staleReverifyOf: job.id,
        label: `reverify ${job.label}`,
      });
      if (r.ok) {
        d.jobs.put({ ...d.jobs.get(job.id)!, pendingReverify: true });
        return commit(() => {}, "reverify");
      }
      const reason = "无空闲槽位重验";
      if (humanFirst) return commit(() => {}, "recorded");
      return commit((t) => { t.status = "parked"; t.statusSince = d.now; t.park = { reason, at: d.now, from: "in_progress" }; }, "parked", reason);
    }
    const reason = "工作区持续变动，证据无法确认";
    if (humanFirst) return commit(() => {}, "recorded");
    return commit((t) => { t.status = "parked"; t.statusSince = d.now; t.park = { reason, at: d.now, from: "in_progress" }; }, "parked", reason);
  }

  if (humanFirst) return commit(() => {}, "recorded");
  if (task.verifyChanged) return commit(() => {}, "recorded");
  const withEv: Task = { ...task }; appendEvidence(withEv, ev);
  if (completionGate(withEv, factsOf(d.jobs))) return commit(() => {}, "recorded");
  return commit((t) => { t.status = "completed"; t.statusSince = d.now; }, "completed");
}

function classifyFp(job: { id: string }, _fp: string) {
  return {} as { interferers?: string[]; overlapUnfinished?: string[] };
}
```

实现注：`classifyFp` 必须真正调用 `classifyOverlap(job, d.jobs)` 并把两集合写回 job（`fpReason` 依赖它们）。删掉上面的空壳，改为：

```ts
import { classifyOverlap, verdictAt } from "../lib/fingerprint.js";
// …
const cls = classifyOverlap(job, d.jobs);
d.jobs.put({ ...job, fpVerdict: fp, interferers: cls.interferers, overlapUnfinished: cls.overlapUnfinished });
```

`chainTerminated` 在本 Task 未使用，交由 T13 的 finalizer；不要在此 import 未用符号（`noUnusedLocals` 若开启会报错）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（15 例）

- [ ] **Step 5: Commit**

```bash
git add src/bind/autofill.ts tests/bind/autofill.test.ts
git commit -m "feat(vigil-todo): 回填、人工优先与 stale 自动重验"
```

---

### Task 13: 两步 finalize（链级落 sidecar + owner 投影）

**Files:**
- Create: `src/bind/finalize.ts`
- Test: `tests/bind/finalize.test.ts`

**Interfaces:**
- Consumes: T1–T12
- Produces:
  - `finalizeChain(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean`
  - `projectFinal(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number): boolean`
  - `finalizeAndProject(rootId, jobs, boards, sessionId, now, note, ok): { finalized: boolean; projected: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/bind/finalize.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { finalizeAndProject, finalizeChain, projectFinal } from "../../src/bind/finalize.js";
import { createBoardStore } from "../../src/board/store.js";
import { EVIDENCE_RING, emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

let jobs: ReturnType<typeof createJobStore>;
let boards: ReturnType<typeof createBoardStore>;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 4,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-fin-")));
  boards = createBoardStore();
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "t", status: "in_progress", inProgressSince: 0, jobs: ["R"] }];
  b.nextId = 2; boards.commit("S", b);
});

it("链未终结时不 finalize", () => {
  jobs.put(j("R", { status: "running", endedAt: null }));
  expect(finalizeChain("R", jobs, 10, "x", false)).toBe(false);
});

it("终结后 finalize 幂等，重复调用仍恰一条（F82）", () => {
  jobs.put(j("R"));
  expect(finalizeChain("R", jobs, 10, "4 次均失败", false)).toBe(true);
  expect(finalizeChain("R", jobs, 20, "again", false)).toBe(false);
  expect(jobs.get("R")?.finalResult?.note).toBe("4 次均失败");
});

it("投影产生唯一 chainFinal 证据（F87）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "S", 30)).toBe(true);
  const ev = boards.get("S").tasks[0].evidence ?? [];
  expect(ev.filter((e) => e.chainFinal)).toHaveLength(1);
  expect(ev[0].at).toBe(30);                       // R8-5：投影时刻
  expect(projectFinal("R", jobs, boards, "S", 40)).toBe(false);
});

it("evidence 环形溢出后仍不重复投影（F83）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  projectFinal("R", jobs, boards, "S", 30);
  const b = boards.get("S");
  b.tasks[0].evidence = Array.from({ length: EVIDENCE_RING }, (_, i) => ({
    ok: true, kind: "job" as const, origin: "async" as const, chainFinal: false,
    at: 100 + i, known: true, fp: "fresh" as const,
  }));
  boards.commit("S", b);
  expect(projectFinal("R", jobs, boards, "S", 200)).toBe(false);
});

it("别的会话不写 owner board（F84）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  expect(projectFinal("R", jobs, boards, "OTHER", 30)).toBe(false);
  expect(boards.get("S").tasks[0].evidence ?? []).toHaveLength(0);
});

it("trigger 从 sidecar 的 kill.requestedBy 读取（F81/F86）", () => {
  jobs.put(j("R", { status: "killed", kill: { requestedBy: "self", at: 5 } }));
  finalizeChain("R", jobs, 10, "killed", false);
  projectFinal("R", jobs, boards, "S", 30);
  expect(boards.get("S").tasks[0].evidence?.[0].trigger).toBe("self");
});

it("无 job 记录的终结路径也能合成证据（F77/F78）", () => {
  jobs.put(j("R", { status: "failed", retryAt: undefined }));
  const r = finalizeAndProject("R", jobs, boards, "S", 50, "spawn failed", false);
  expect(r.finalized).toBe(true);
  expect(r.projected).toBe(true);
  expect(boards.get("S").tasks[0].evidence?.[0].ref).toBe("R");
});

it("迟投影 at=now 不被 watermark 遮蔽（F91）", () => {
  jobs.put(j("R"));
  finalizeChain("R", jobs, 10, "done", true);
  const b = boards.get("S"); b.counters.wakeWatermark = 100; boards.commit("S", b);
  projectFinal("R", jobs, boards, "S", 200);
  expect(boards.get("S").tasks[0].evidence?.[0].at).toBe(200);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/bind/finalize.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/bind/finalize.ts
import { appendEvidence } from "../board/evidence.js";
import type { BoardStore } from "../board/store.js";
import { chainTerminated } from "../jobs/chain.js";
import type { JobStore } from "../jobs/store.js";

/** 第一步：链级终结，权威在 sidecar，任何会话都可做，幂等。 */
export function finalizeChain(rootId: string, jobs: JobStore, now: number, note: string, ok: boolean): boolean {
  if (!chainTerminated(jobs, rootId)) return false;
  const root = jobs.get(rootId);
  if (!root || root.finalized) return false;
  jobs.put({
    ...root,
    finalized: true,
    finalResult: { ok, note, trigger: root.kill?.requestedBy ?? "external", at: now },
  });
  jobs.save();
  return true;
}

/** 第二步：只有 owner 会话能写自己的 board（铁律）。 */
export function projectFinal(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number): boolean {
  const root = jobs.get(rootId);
  if (!root?.finalized || root.evidenceApplied) return false;
  if (root.sessionId !== sessionId) return false;
  const board = boards.get(sessionId);
  const idx = board.tasks.findIndex((t) => t.id === root.taskId);
  if (idx < 0) return false;
  const task = { ...board.tasks[idx] };
  appendEvidence(task, {
    ok: root.finalResult!.ok, kind: "job", origin: "async", chainFinal: true,
    trigger: root.finalResult!.trigger, at: now, known: true,
    fp: root.fpVerdict, ref: rootId, note: root.finalResult!.note,
    exitCode: root.exitCode,
  });
  const tasks = [...board.tasks]; tasks[idx] = task;
  boards.commit(sessionId, { ...board, tasks });
  jobs.put({ ...root, evidenceApplied: true });
  jobs.save();
  return true;
}

export function finalizeAndProject(rootId: string, jobs: JobStore, boards: BoardStore, sessionId: string, now: number, note: string, ok: boolean) {
  return {
    finalized: finalizeChain(rootId, jobs, now, note, ok),
    projected: projectFinal(rootId, jobs, boards, sessionId, now),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（8 例）

- [ ] **Step 5: Commit**

```bash
git add src/bind/finalize.ts tests/bind/finalize.test.ts
git commit -m "feat(vigil-todo): 两步 finalize，链级幂等落 sidecar 与 owner 投影"
```

---

### Task 14: sweep——defer 释放、respawn 补驱动与 root 粒度补偿扫描

**Files:**
- Create: `src/bind/sweep.ts`
- Test: `tests/bind/sweep.test.ts`

**Interfaces:**
- Consumes: T1–T13
- Produces:
  - `SweepDeps { boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string; respawn(req): {ok:boolean}; notify(n: string): void; isIdle(): boolean }`
  - `sweepDefers(d: SweepDeps): number`
  - `sweepRespawns(d: SweepDeps): number`
  - `catchUpScan(d: SweepDeps): string[]`（返回待补发 rootId）
  - `sweepAll(d: SweepDeps): { defersReleased: number; respawned: number; catchUp: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/bind/sweep.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { catchUpScan, sweepAll, sweepDefers, sweepRespawns, type SweepDeps } from "../../src/bind/sweep.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let d: SweepDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: false, notifyState: "pending", ...o,
});

beforeEach(() => {
  boards = createBoardStore(); jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-sw-")));
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "a", status: "in_progress", inProgressSince: 0 },
    { id: 2, subject: "b", status: "pending", defer: { untilRoot: "R", reason: "冲突", at: 1 } },
  ];
  b.nextId = 3; boards.commit("S", b);
  d = { boards, jobs, cfg: DEFAULTS, now: 1000, sessionId: "S", respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
});

it("链未终结时 defer 不释放（F18）", () => {
  jobs.put(j("R", { status: "failed", retryAt: 5000 }));
  expect(sweepDefers(d)).toBe(0);
  expect(boards.get("S").tasks[1].defer).toBeDefined();
});

it("整链终结后释放 defer（F18）", () => {
  jobs.put(j("R", { attempt: 4 }));
  expect(sweepDefers(d)).toBe(1);
  expect(boards.get("S").tasks[1].defer).toBeUndefined();
});

it("untilRoot 无记录 → 释放 + notify（F34）", () => {
  let note = "";
  d.notify = (n) => { note = n; };
  expect(sweepDefers(d)).toBe(1);
  expect(note).toContain("R");
});

it("retryAt 到期即 respawn（F45）", () => {
  jobs.put(j("R", { retryAt: 500 }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("retryAt 未到期不 respawn", () => {
  jobs.put(j("R", { retryAt: 5000 }));
  expect(sweepRespawns(d)).toBe(0);
});

it("pendingReverify 且未终结 → 补一次 respawn（F85）", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, fpVerdict: "stale" }));
  let called = 0;
  d.respawn = () => { called++; return { ok: true }; };
  expect(sweepRespawns(d)).toBe(1);
  expect(called).toBe(1);
});

it("pendingReverify 额度已尽 → 判终结 parked，不悬置（F85）", () => {
  jobs.put(j("R", { status: "completed", exitCode: 0, pendingReverify: true, attempt: 4 }));
  jobs.put(j("R2", { rootId: "R", retryOf: "R", staleReverifyOf: "R" }));
  d.respawn = () => ({ ok: false });
  sweepRespawns(d);
  expect(jobs.get("R")?.pendingReverify).toBe(false);
});

it("catch-up 只扫 root 粒度：中间失败 job 不入扫描集（F89）", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  jobs.put(j("M", { rootId: "R", attempt: 2, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("acked 永不补发（F8）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "acked" }));
  expect(catchUpScan(d)).toEqual([]);
});

it("sent 未超 10min 不补发", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 900 }));
  expect(catchUpScan(d)).toEqual([]);
});

it("非 idle 时跳过 sent 补发（F80）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: true, notifyState: "sent", notifySentAt: 0 }));
  expect(catchUpScan({ ...d, isIdle: () => false })).toEqual([]);
});

it("未投影的 finalized 链优先入扫描集（F84）", () => {
  jobs.put(j("R", { finalized: true, evidenceApplied: false, notifyState: "pending" }));
  expect(catchUpScan(d)).toEqual(["R"]);
});

it("sweepAll 汇总三项", () => {
  jobs.put(j("R", { attempt: 4, finalized: true, evidenceApplied: true, notifyState: "acked" }));
  const r = sweepAll(d);
  expect(r.defersReleased).toBe(1);
  expect(r.respawned).toBe(0);
  expect(r.catchUp).toEqual([]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/bind/sweep.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/bind/sweep.ts
import type { BoardStore } from "../board/store.js";
import { canReverify, chainJobs, chainTerminated } from "../jobs/chain.js";
import { claim, release } from "../jobs/claims.js";
import type { JobStore } from "../jobs/store.js";
import type { SpawnRequest } from "../jobs/spawn.js";
import type { VigilConfig } from "../lib/config.js";
import { projectFinal } from "./finalize.js";

export interface SweepDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string;
  respawn(req: SpawnRequest): { ok: boolean };
  notify(note: string): void;
  isIdle(): boolean;
}

export function sweepDefers(d: SweepDeps): number {
  const board = d.boards.get(d.sessionId);
  let released = 0;
  const tasks = board.tasks.map((t) => {
    if (!t.defer) return t;
    const root = d.jobs.get(t.defer.untilRoot);
    if (root && !chainTerminated(d.jobs, t.defer.untilRoot)) return t;
    if (!root) d.notify(`defer 目标 ${t.defer.untilRoot} 已无记录，已释放 #${t.id}（repair）`);
    released++;
    const next = { ...t }; delete next.defer; return next;
  });
  if (released > 0) d.boards.commit(d.sessionId, { ...board, tasks });
  return released;
}

export function sweepRespawns(d: SweepDeps): number {
  let n = 0;
  for (const job of d.jobs.all()) {
    const dueBackoff = job.retryAt != null && job.retryAt <= d.now;
    const root = d.jobs.get(job.rootId);
    const dueReverify = root?.pendingReverify === true && !root.finalized && job.id === root.id;
    if (!dueBackoff && !dueReverify) continue;
    if (!claim(d.jobs.all().length ? job.cwd : job.cwd, job.rootId, "respawn", d.sessionId, d.now)) continue;
    // claim 目录由调用方注入更合适；此处用 runDir(job.cwd)
    const req: SpawnRequest = dueReverify
      ? { command: job.command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
          rootId: job.rootId, retryOf: job.id, attempt: job.attempt, staleReverifyOf: job.id }
      : { command: job.command, cwd: job.cwd, taskId: job.taskId, sessionId: job.sessionId,
          rootId: job.rootId, retryOf: job.id, attempt: job.attempt + 1 };
    const r = d.respawn(req);
    if (r.ok) {
      const cur = d.jobs.get(job.id)!;
      const next = { ...cur };
      delete next.retryAt;
      if (dueReverify) next.pendingReverify = false;
      d.jobs.put(next);
      n++;
    } else if (dueReverify) {
      const cur = d.jobs.get(job.id)!;
      d.jobs.put({ ...cur, pendingReverify: false });     // 额度尽/无槽 ⇒ 不悬置
    }
    release(job.cwd, job.rootId, "respawn");
  }
  d.jobs.save();
  return n;
}

/** root 粒度扫描集（规格 §5.3）。 */
export function catchUpScan(d: SweepDeps): string[] {
  const out: string[] = [];
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId) continue;                 // 只看 root
    if (root.sessionId !== d.sessionId) continue;
    if (!root.finalized) continue;
    if (!root.evidenceApplied) { out.push(root.id); continue; }
    if (root.notifyState === "acked") continue;
    if (root.notifyState === "pending") { out.push(root.id); continue; }
    const overdue = d.now - (root.notifySentAt ?? 0) > d.cfg.notifyRetryMs;
    if (overdue && d.isIdle()) out.push(root.id);
  }
  return out;
}

export function sweepAll(d: SweepDeps) {
  for (const id of catchUpScan(d)) projectFinal(id, d.jobs, d.boards, d.sessionId, d.now);
  return { defersReleased: sweepDefers(d), respawned: sweepRespawns(d), catchUp: catchUpScan(d) };
}
```

实现注：`claim/release` 的第一个参数必须是 **runDir**（`runDir(job.cwd)`），不是 `job.cwd`。上面 `d.jobs.all().length ? job.cwd : job.cwd` 是占位错误，实现时改为 `import { runDir } from "../jobs/store.js"` 并用 `runDir(job.cwd)`。`canReverify`/`chainJobs` 若未使用则不要 import。

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（13 例）

- [ ] **Step 5: Commit**

```bash
git add src/bind/sweep.ts tests/bind/sweep.test.ts
git commit -m "feat(vigil-todo): defer 释放、respawn 补驱动与 root 粒度补偿扫描"
```

---

### Task 15: 投递判据与唤醒文案（watermark 只在投递时推进）

**Files:**
- Create: `src/wake/deliver.ts`, `src/wake/compose.ts`
- Test: `tests/wake/deliver.test.ts`, `tests/wake/compose.test.ts`

**Interfaces:**
- Consumes: T1–T14
- Produces:
  - `DeliverInput { board: BoardState; jobs: JobStore; cfg: VigilConfig; now: number; trigger: "async"|"boundary"; modelAdvanced: boolean; capacityFull: boolean }`
  - `tryDeliver(input): { kind: "none" } | { kind: "deliver"; wakeId: string; roots: string[]; text: string; counters: BoardCounters; renudge: boolean }`
  - `composeWake(roots, board, jobs, cfg, next): string`
  - `WAKE_CUSTOM_TYPE = "vigil-todo-wake"`

- [ ] **Step 1: 写失败测试**

```ts
// tests/wake/deliver.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { emptyBoard, type BoardState, type Evidence } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { tryDeliver } from "../../src/wake/deliver.js";

let jobs: ReturnType<typeof createJobStore>;
let board: BoardState;
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 500, known: true, fp: "fresh", ref: "R", ...o,
});
const root = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "r", command: "true", logPath: "/tmp/r.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending", ...o,
});
const input = (over: Partial<Parameters<typeof tryDeliver>[0]> = {}) => ({
  board, jobs, cfg: DEFAULTS, now: 1000, trigger: "async" as const, modelAdvanced: true, capacityFull: false, ...over,
});

beforeEach(() => {
  jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-wake-")));
  board = emptyBoard();
  board.tasks = [
    { id: 1, subject: "a", status: "completed", inProgressSince: 0, jobs: ["R"], evidence: [ev()] },
    { id: 2, subject: "b", status: "pending" },
  ];
  board.nextId = 3;
  jobs.put(root());
});

it("有未投递 chainFinal → 投递并推进 watermark（F59）", () => {
  const r = tryDeliver(input());
  expect(r.kind).toBe("deliver");
  if (r.kind !== "deliver") return;
  expect(r.counters.wakeWatermark).toBe(500);
  expect(r.counters.turnsUsed).toBe(1);
  expect(r.counters.renudgeBudget).toBe(1);
  expect(r.roots).toEqual(["R"]);
});

it("同一证据第二次不再投递（F59/F7）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("tool 证据不进 undelivered（F44）", () => {
  board.tasks[0].evidence = [ev({ origin: "tool", kind: "command" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("per-job 非 chainFinal 证据不投递（F74/F87）", () => {
  board.tasks[0].evidence = [ev({ chainFinal: false }), ev({ chainFinal: false, at: 400 })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("trigger:self 不投递（F81）", () => {
  board.tasks[0].evidence = [ev({ trigger: "self" })];
  expect(tryDeliver(input()).kind).toBe("none");
});

it("turnsUsed 达上限第一行硬停（F24/F43）", () => {
  board.counters.turnsUsed = DEFAULTS.maxTurns;
  expect(tryDeliver(input()).kind).toBe("none");
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("模型无动作 + next 存在 → re-nudge 恰一次（F23）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  const b = tryDeliver(input({ trigger: "boundary", modelAdvanced: false }));
  expect(b.kind).toBe("deliver");
  if (b.kind !== "deliver") return;
  expect(b.renudge).toBe(true);
  expect(b.counters.renudgeBudget).toBe(0);
  board = { ...board, counters: b.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: false })).kind).toBe("none");
});

it("模型已推进则不 re-nudge（F23）", () => {
  const a = tryDeliver(input());
  if (a.kind !== "deliver") throw new Error("expected deliver");
  board = { ...board, counters: a.counters };
  expect(tryDeliver(input({ trigger: "boundary", modelAdvanced: true })).kind).toBe("none");
});

it("WIP 满时 next 为空且文案不写开干（F40）", () => {
  board.tasks[1].status = "in_progress";
  board.tasks.push({ id: 3, subject: "c", status: "in_progress" }, { id: 4, subject: "d", status: "in_progress" });
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.text).toContain("WIP 满");
  expect(r.text).not.toContain("开干");
});

it("多条 chainFinal 合并为一条（F38）", () => {
  board.tasks[0].evidence = [ev({ ref: "R" }), ev({ ref: "R2", at: 501 })];
  jobs.put(root({ id: "R2", rootId: "R2" }));
  const r = tryDeliver(input());
  if (r.kind !== "deliver") throw new Error("expected deliver");
  expect(r.roots.sort()).toEqual(["R", "R2"]);
});
```

```ts
// tests/wake/compose.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { composeWake } from "../../src/wake/compose.js";

const j = (o: Partial<Job> = {}): Job => ({
  id: "R", label: "回归", command: "npm test", logPath: "/tmp/none.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: "R", attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending",
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, ...o,
});

it("成功消息含三个真实调用形态与 next", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cmp-"))); jobs.put(j());
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "回归", status: "completed" }, { id: 2, subject: "清理", status: "pending" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, b.tasks[1]);
  expect(text).toContain("[vigil-todo]");
  expect(text).toContain("next: #2");
  expect(text).toContain('bg_run({task_id:2');
  expect(text).toContain('status:"parked"');
  expect(text).toContain("defer:{untilJob:");
});

it("失败消息附日志尾（F72）", () => {
  const d = mkdtempSync(join(tmpdir(), "vigil-cmp-"));
  const log = join(d, "f.log");
  writeFileSync(log, Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n"));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log, finalResult: { ok: false, note: "4 次均失败", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain("L49");
  expect(text).not.toContain("L0\n");
});

it("stale 用尽给 accept/verify 两条路（F20）", () => {
  const jobs = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cmp-")));
  jobs.put(j({ fpVerdict: "stale", finalResult: { ok: false, note: "工作区持续变动，证据无法确认", trigger: "external", at: 2 } }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  const text = composeWake(["R"], b, jobs, DEFAULTS, undefined);
  expect(text).toContain('accept:"stale"');
  expect(text).toContain('action:"verify"');
});

it("消息长度受控（≤1200 token 近似：字符上限）", () => {
  const d = mkdtempSync(join(tmpdir(), "vigil-cmp-"));
  const log = join(d, "big.log");
  writeFileSync(log, "x".repeat(100_000));
  const jobs = createJobStore(d);
  jobs.put(j({ status: "failed", exitCode: 1, logPath: log }));
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "回归", status: "parked" }];
  expect(composeWake(["R"], b, jobs, DEFAULTS, undefined).length).toBeLessThan(4800);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/wake`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 compose**

```ts
// src/wake/compose.ts
import { selectNext } from "../board/selectors.js";
import type { BoardState, Task } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { fpReason } from "../lib/fingerprint.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";
import { tailLines } from "../lib/tail.js";

export const WAKE_CUSTOM_TYPE = "vigil-todo-wake";

export function composeWake(roots: string[], board: BoardState, jobs: JobStore, cfg: VigilConfig, next: Task | undefined): string {
  const lines: string[] = [];
  for (const id of roots) {
    const j = jobs.get(id);
    if (!j) continue;
    const task = board.tasks.find((t) => t.id === j.taskId);
    const label = sanitizeTerminalText(j.label);
    const tag = j.finalResult?.ok ? "✓" : "✗";
    lines.push(`[vigil-todo] #${j.taskId ?? "?"} ${label} ${tag} exit ${j.exitCode ?? "?"} (${j.id}) ${fpReason(j)}`);
    if (j.finalResult && !j.finalResult.ok) lines.push(`  ${sanitizeTerminalText(j.finalResult.note)}`);
    if (j.fpVerdict === "stale" && task?.status === "parked") {
      lines.push(`  → todo({action:"update", id:${j.taskId}, status:"completed", accept:"stale"})`);
      lines.push(`    todo({action:"verify", id:${j.taskId}})`);
    }
    if (!j.finalResult?.ok) {
      const tail = tailLines(j.logPath, cfg.tailLines, cfg.maxTailBytes);
      if (tail.length) { lines.push(`  log tail (last ${tail.length}):`); for (const l of tail) lines.push(`    ${sanitizeTerminalText(l).slice(0, 200)}`); }
    }
  }
  const active = board.tasks.filter((t) => t.status === "in_progress").length;
  if (next) {
    lines.push(`next: #${next.id} ${sanitizeTerminalText(next.subject)} (pending, unblocked)`);
    lines.push(`→ 开干: bg_run({task_id:${next.id}, command:"…"})`);
    lines.push(`  需人拍板: todo({action:"update", id:${next.id}, status:"parked", reason:"…"})`);
    lines.push(`  冲突需串行: todo({action:"update", id:${next.id}, defer:{untilJob:"bg_…", reason:"…"}})`);
  } else if (active >= cfg.wipLimit) {
    lines.push(`WIP 满 (${active}/${cfg.wipLimit})，先 park 一个或等一个完成`);
  } else {
    lines.push("无可推进任务");
  }
  return lines.join("\n").slice(0, 4800);
}
```

- [ ] **Step 4: 实现 deliver**

```ts
// src/wake/deliver.ts
import { selectNext } from "../board/selectors.js";
import type { BoardCounters, BoardState } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { composeWake } from "./compose.js";

export interface DeliverInput {
  board: BoardState; jobs: JobStore; cfg: VigilConfig; now: number;
  trigger: "async" | "boundary"; modelAdvanced: boolean; capacityFull: boolean;
}
export type DeliverResult =
  | { kind: "none" }
  | { kind: "deliver"; wakeId: string; roots: string[]; text: string; counters: BoardCounters; renudge: boolean };

let wakeSeq = 0;

export function tryDeliver(i: DeliverInput): DeliverResult {
  const c = i.board.counters;
  if (c.turnsUsed >= i.cfg.maxTurns) return { kind: "none" };      // ★ 第一行硬闸门

  const pending = i.board.tasks.flatMap((t) => t.evidence ?? [])
    .filter((e) => e.origin === "async" && e.chainFinal && e.trigger !== "self" && e.at > c.wakeWatermark);

  const next = selectNext(i.board, i.cfg.wipLimit, i.capacityFull);

  if (pending.length > 0) {
    const roots = [...new Set(pending.map((e) => e.ref).filter((r): r is string => typeof r === "string"))];
    const counters: BoardCounters = {
      turnsUsed: c.turnsUsed + 1,
      wakeWatermark: Math.max(...pending.map((e) => e.at)),
      renudgeBudget: 1,
    };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots,
      text: composeWake(roots, i.board, i.jobs, i.cfg, next), counters, renudge: false };
  }

  if (i.trigger === "boundary" && c.renudgeBudget > 0 && !i.modelAdvanced && next) {
    const counters: BoardCounters = { ...c, turnsUsed: c.turnsUsed + 1, renudgeBudget: c.renudgeBudget - 1 };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots: [],
      text: composeWake([], i.board, i.jobs, i.cfg, next), counters, renudge: true };
  }
  return { kind: "none" };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（14 例）

- [ ] **Step 6: Commit**

```bash
git add src/wake/deliver.ts src/wake/compose.ts tests/wake
git commit -m "feat(vigil-todo): 单一投递判据与唤醒文案，watermark 投递时推进"
```

---

### Task 16: 双路 ack、input 归零与 renudge 清零

**Files:**
- Create: `src/wake/ack.ts`
- Test: `tests/wake/ack.test.ts`

**Interfaces:**
- Consumes: T7 `JobStore`、T15 `WAKE_CUSTOM_TYPE`
- Produces:
  - `ackByWakeId(jobs, wakeId): number`
  - `ackPendingBoundary(jobs, sessionId): number`
  - `markSent(jobs, roots, wakeId, now): void`
  - `resetOnUserInput(counters): BoardCounters`
  - `clearRenudgeOnSettled(counters): BoardCounters`
  - `createAckTracker()` → `{ expectBoundary(wakeId, roots): void; onAgentStart(jobs, sessionId): number; onMessage(jobs, customType, wakeId): number }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/wake/ack.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { ackByWakeId, clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../../src/wake/ack.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-ack-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending", ...o,
});

it("markSent 只写 root 记录（F89）", () => {
  const s = store();
  s.put(j("R")); s.put(j("M", { rootId: "R" }));
  markSent(s, ["R"], "w1", 100);
  expect(s.get("R")).toMatchObject({ notifyState: "sent", wakeId: "w1", notifySentAt: 100 });
  expect(s.get("M")?.notifyState).toBe("pending");
});

it("message 路径按 wakeId 批量 ack（F55）", () => {
  const s = store();
  s.put(j("R")); s.put(j("R2"));
  markSent(s, ["R", "R2"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, "vigil-todo-wake", "w1")).toBe(2);
  expect(s.get("R")?.notifyState).toBe("acked");
  expect(s.get("R2")?.notifyState).toBe("acked");
});

it("不匹配的 customType / wakeId 不 ack", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, "other", "w1")).toBe(0);
  expect(t.onMessage(s, "vigil-todo-wake", "wX")).toBe(0);
});

it("boundary 路径靠紧随的 agent_start ack（F61）", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(t.onAgentStart(s, "S")).toBe(1);
  expect(s.get("R")?.notifyState).toBe("acked");
});

it("boundary entries 被丢弃 ⇒ 无 agent_start ⇒ 留 sent（F71）", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(s.get("R")?.notifyState).toBe("sent");
});

it("acked 幂等，重复 ack 不重复计数", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  expect(ackByWakeId(s, "w1")).toBe(1);
  expect(ackByWakeId(s, "w1")).toBe(0);
});

it("用户 input 归零 turnsUsed（F65）", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 49, wakeWatermark: 500, renudgeBudget: 1 };
  expect(resetOnUserInput(b.counters)).toEqual({ turnsUsed: 0, wakeWatermark: 500, renudgeBudget: 1 });
});

it("agent_settled 清零 renudgeBudget（F70）", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 3, wakeWatermark: 500, renudgeBudget: 1 };
  expect(clearRenudgeOnSettled(b.counters).renudgeBudget).toBe(0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/wake/ack.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/wake/ack.ts
import type { BoardCounters } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import { WAKE_CUSTOM_TYPE } from "./compose.js";

/** 只写 root 记录（规格 §5.3 类型约束）。 */
export function markSent(jobs: JobStore, roots: string[], wakeId: string, now: number): void {
  for (const id of roots) {
    const j = jobs.get(id);
    if (!j || j.id !== j.rootId) continue;
    jobs.put({ ...j, notifyState: "sent", wakeId, notifySentAt: now });
  }
  jobs.save();
}

export function ackByWakeId(jobs: JobStore, wakeId: string): number {
  let n = 0;
  for (const j of jobs.all()) {
    if (j.id !== j.rootId || j.wakeId !== wakeId || j.notifyState === "acked") continue;
    jobs.put({ ...j, notifyState: "acked" });
    n++;
  }
  if (n) jobs.save();
  return n;
}

export function ackPendingBoundary(jobs: JobStore, sessionId: string): number {
  let n = 0;
  for (const j of jobs.all()) {
    if (j.id !== j.rootId || j.sessionId !== sessionId) continue;
    if (j.notifyState !== "sent") continue;
    jobs.put({ ...j, notifyState: "acked" });
    n++;
  }
  if (n) jobs.save();
  return n;
}

export const resetOnUserInput = (c: BoardCounters): BoardCounters => ({ ...c, turnsUsed: 0 });
export const clearRenudgeOnSettled = (c: BoardCounters): BoardCounters => ({ ...c, renudgeBudget: 0 });

/** boundary 投递后等待紧随的 agent_start；entries 被丢弃则永远等不到 ⇒ 留 sent 由 catch-up 兜。 */
export function createAckTracker() {
  let pendingBoundary: { wakeId: string; roots: string[] } | undefined;
  return {
    expectBoundary(wakeId: string, roots: string[]) { pendingBoundary = { wakeId, roots }; },
    onAgentStart(jobs: JobStore, _sessionId: string): number {
      if (!pendingBoundary) return 0;
      const { wakeId } = pendingBoundary;
      pendingBoundary = undefined;
      return ackByWakeId(jobs, wakeId);
    },
    onMessage(jobs: JobStore, customType: string, wakeId: unknown): number {
      if (customType !== WAKE_CUSTOM_TYPE || typeof wakeId !== "string") return 0;
      return ackByWakeId(jobs, wakeId);
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（8 例）

- [ ] **Step 5: Commit**

```bash
git add src/wake/ack.ts tests/wake/ack.test.ts
git commit -m "feat(vigil-todo): 双路 ack、input 归零与 settled 清零"
```

---

### Task 17: 孤儿链收养（心跳 gate、认领、重编号、冻结）

**Files:**
- Create: `src/bind/adopt.ts`
- Test: `tests/bind/adopt.test.ts`

**Interfaces:**
- Consumes: T1–T16
- Produces:
  - `AdoptDeps { boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string; dir: string; readOldBoard(sessionId: string): BoardState | undefined; notify(n: string): void; manual?: boolean }`
  - `adoptableRoots(d: AdoptDeps): string[]`
  - `importTasks(oldBoard, taskIds, board, oldSessionId): { board: BoardState; remap: Map<number, number> }`
  - `adoptOrphans(d: AdoptDeps): { adopted: string[]; imported: number }`
  - `freezeMovedAway(d: AdoptDeps): number`

- [ ] **Step 1: 写失败测试**

```ts
// tests/bind/adopt.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { adoptOrphans, adoptableRoots, freezeMovedAway, importTasks, type AdoptDeps } from "../../src/bind/adopt.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard, type BoardState } from "../../src/board/types.js";
import { writeHeartbeat } from "../../src/jobs/heartbeat.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { DEFAULTS } from "../../src/lib/config.js";

let d: AdoptDeps;
let boards: ReturnType<typeof createBoardStore>;
let jobs: ReturnType<typeof createJobStore>;
let dir: string;
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], overlapUnfinished: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "OLD", evidenceApplied: false, finalized: true,
  finalResult: { ok: true, note: "done", trigger: "external", at: 2 }, notifyState: "pending", ...o,
});
const oldBoard = (): BoardState => {
  const b = emptyBoard();
  b.tasks = [
    { id: 1, subject: "回归", status: "in_progress", inProgressSince: 0, jobs: ["R"] },
    { id: 2, subject: "文档", status: "pending", blockedBy: [1] },
    { id: 3, subject: "已完成依赖", status: "completed" },
  ];
  b.nextId = 4;
  return b;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vigil-adopt-"));
  boards = createBoardStore(); jobs = createJobStore(dir);
  boards.commit("NEW", emptyBoard());
  d = { boards, jobs, cfg: DEFAULTS, now: 100_000, sessionId: "NEW", dir,
        readOldBoard: () => oldBoard(), notify: () => {} };
});

it("owner 不活跃 + finalized + 未投影 ⇒ 可收养（F88）", () => {
  jobs.put(j("R"));
  expect(adoptableRoots(d)).toEqual(["R"]);
});

it("running 链不收养（F92/F104）", () => {
  jobs.put(j("R", { status: "running", endedAt: null, finalized: false }));
  expect(adoptableRoots(d)).toEqual([]);
  expect(adoptableRoots({ ...d, manual: true })).toEqual([]);
});

it("owner 心跳新鲜 ⇒ 不收养（F96）", () => {
  jobs.put(j("R"));
  writeHeartbeat(dir, "OLD", process.pid, d.now);
  expect(adoptableRoots(d)).toEqual([]);
});

it("suspect 时人工 adopt 绕过 gate（F98）", () => {
  jobs.put(j("R"));
  writeHeartbeat(dir, "OLD", process.pid, 0);
  expect(adoptableRoots(d)).toEqual([]);
  expect(adoptableRoots({ ...d, manual: true })).toEqual(["R"]);
});

it("导入即重编号，不撞号（F93）", () => {
  const cur = emptyBoard();
  cur.tasks = [{ id: 1, subject: "新会话已有", status: "pending" }];
  cur.nextId = 2;
  const r = importTasks(oldBoard(), [1, 2], cur, "OLD");
  expect(r.board.tasks.map((t) => t.id)).toEqual([1, 2, 3]);
  expect(r.board.tasks[1].metadata?.adoptedFrom).toEqual({ session: "OLD", id: 1 });
  expect(r.board.tasks[2].blockedBy).toEqual([2]);
});

it("旧 board 已 completed 的悬空依赖被删除（F100）", () => {
  const ob = oldBoard();
  ob.tasks[1].blockedBy = [3];
  const r = importTasks(ob, [2], emptyBoard(), "OLD");
  expect(r.board.tasks[0].blockedBy).toBeUndefined();
  expect(r.board.tasks[0].metadata?.resolvedDeps).toEqual([3]);
});

it("非终态悬空依赖保留（F100）", () => {
  const ob = oldBoard();
  ob.tasks[1].blockedBy = [1];
  const r = importTasks(ob, [2], emptyBoard(), "OLD");
  expect(r.board.tasks[0].blockedBy).toEqual([1]);
});

it("多链绑同一任务只导入一次（F93）", () => {
  jobs.put(j("R")); jobs.put(j("R2", { taskId: 1 }));
  const r = adoptOrphans(d);
  expect(r.imported).toBe(1);
});

it("收养后移交 sessionId 并投影（F88）", () => {
  jobs.put(j("R"));
  const r = adoptOrphans(d);
  expect(r.adopted).toEqual(["R"]);
  expect(jobs.get("R")?.sessionId).toBe("NEW");
  expect(boards.get("NEW").tasks.some((t) => (t.evidence ?? []).some((e) => e.chainFinal))).toBe(true);
});

it("两会话竞争只有一个收养者（F94/F101）", () => {
  jobs.put(j("R"));
  const a = adoptOrphans(d);
  const b = adoptOrphans({ ...d, sessionId: "NEW2", boards });
  expect(a.adopted.length + b.adopted.length).toBe(1);
});

it("旧会话重开时冻结已移交任务（F95/F97）", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "回归", status: "in_progress", jobs: ["R"] }];
  boards.commit("OLD", b);
  jobs.put(j("R", { sessionId: "NEW" }));
  writeHeartbeat(dir, "NEW", process.pid, d.now);
  expect(freezeMovedAway({ ...d, sessionId: "OLD" })).toBe(1);
  expect(boards.get("OLD").tasks[0].metadata?.adoptedAway).toEqual({ session: "NEW" });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/bind/adopt.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/bind/adopt.ts
import type { BoardStore } from "../board/store.js";
import type { BoardState, Task } from "../board/types.js";
import { claim, release } from "../jobs/claims.js";
import { readLiveness } from "../jobs/heartbeat.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { projectFinal } from "./finalize.js";

export interface AdoptDeps {
  boards: BoardStore; jobs: JobStore; cfg: VigilConfig; now: number; sessionId: string; dir: string;
  readOldBoard(sessionId: string): BoardState | undefined;
  notify(note: string): void;
  manual?: boolean;
}

const settled = (s: Task["status"]) => s === "completed" || s === "deleted";

export function adoptableRoots(d: AdoptDeps): string[] {
  const out: string[] = [];
  for (const root of d.jobs.all()) {
    if (root.id !== root.rootId) continue;
    if (!root.finalized || root.evidenceApplied) continue;
    if (root.sessionId === d.sessionId) continue;
    if (root.status === "running") continue;                    // F92/F104：running 永不收
    if (!d.manual) {
      const live = readLiveness(d.dir, root.sessionId ?? "", d.now, d.cfg.heartbeatStaleMs, d.cfg.hungSuspectMs);
      if (live !== "inactive") continue;                        // suspect 也跳过，人工才可绕
    }
    out.push(root.id);
  }
  return out;
}

/** 导入即重编号 + 悬空依赖对照旧快照解析（规格 §7.1.1-D）。 */
export function importTasks(oldBoard: BoardState, taskIds: number[], board: BoardState, oldSessionId: string) {
  const remap = new Map<number, number>();
  const uniq = [...new Set(taskIds)];
  let nextId = board.nextId;
  const imported: Task[] = [];
  for (const oldId of uniq) {
    const src = oldBoard.tasks.find((t) => t.id === oldId);
    if (!src) continue;
    const id = nextId++;
    remap.set(oldId, id);
    imported.push({ ...src, id, metadata: { ...(src.metadata ?? {}), adoptedFrom: { session: oldSessionId, id: oldId } } });
  }
  for (const t of imported) {
    if (!t.blockedBy?.length) continue;
    const kept: number[] = [];
    const resolved: number[] = [];
    for (const dep of t.blockedBy) {
      const mapped = remap.get(dep);
      if (mapped !== undefined) { kept.push(mapped); continue; }
      const old = oldBoard.tasks.find((x) => x.id === dep);
      if (old && settled(old.status)) { resolved.push(dep); continue; }
      kept.push(dep);                                            // 非终态：保留悬空
    }
    if (kept.length) t.blockedBy = kept; else delete t.blockedBy;
    if (resolved.length) t.metadata = { ...(t.metadata ?? {}), resolvedDeps: resolved };
  }
  return { board: { ...board, tasks: [...board.tasks, ...imported], nextId }, remap };
}

export function adoptOrphans(d: AdoptDeps) {
  const adopted: string[] = [];
  let imported = 0;
  const roots = adoptableRoots(d);
  const bySession = new Map<string, string[]>();
  for (const id of roots) {
    const root = d.jobs.get(id)!;
    const sid = root.sessionId ?? "";
    bySession.set(sid, [...(bySession.get(sid) ?? []), id]);
  }
  for (const [oldSid, ids] of bySession) {
    const oldBoard = d.readOldBoard(oldSid);
    if (!oldBoard) { d.notify(`孤儿链 ${ids.join(",")} 的旧 board 不可读，跳过`); continue; }
    const won: string[] = [];
    for (const id of ids) {
      if (!claim(d.dir, id, "adopt", d.sessionId, d.now)) continue;
      won.push(id);
    }
    if (won.length === 0) continue;
    const taskIds = won.map((id) => d.jobs.get(id)?.taskId).filter((x): x is number => typeof x === "number");
    const before = d.boards.get(d.sessionId);
    const { board, remap } = importTasks(oldBoard, taskIds, before, oldSid);
    d.boards.commit(d.sessionId, board);
    imported += remap.size;
    for (const id of won) {
      const root = d.jobs.get(id)!;
      const newTaskId = root.taskId !== undefined ? remap.get(root.taskId) ?? root.taskId : undefined;
      d.jobs.put({ ...root, sessionId: d.sessionId, taskId: newTaskId });
      projectFinal(id, d.jobs, d.boards, d.sessionId, d.now);
      release(d.dir, id, "adopt");
      adopted.push(id);
    }
    d.notify(`已从会话 ${oldSid} 接管 ${remap.size} 个任务、${won.length} 条已终结作业（repair）`);
  }
  d.jobs.save();
  return { adopted, imported };
}

/** 旧会话重开：本 board 的任务链已归属别的活跃会话 ⇒ 冻结（规格 §7.1.1-E）。 */
export function freezeMovedAway(d: AdoptDeps): number {
  const board = d.boards.get(d.sessionId);
  let n = 0;
  const tasks = board.tasks.map((t) => {
    if (t.metadata?.adoptedAway) return t;
    const moved = (t.jobs ?? []).map((id) => d.jobs.get(id)).find((j) => j && j.sessionId !== d.sessionId);
    if (!moved) return t;
    const live = readLiveness(d.dir, moved.sessionId ?? "", d.now, d.cfg.heartbeatStaleMs, d.cfg.hungSuspectMs);
    if (live === "inactive") return t;
    n++;
    return { ...t, metadata: { ...(t.metadata ?? {}), adoptedAway: { session: moved.sessionId } } };
  });
  if (n) d.boards.commit(d.sessionId, { ...board, tasks });
  return n;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（11 例）

- [ ] **Step 5: Commit**

```bash
git add src/bind/adopt.ts tests/bind/adopt.test.ts
git commit -m "feat(vigil-todo): 孤儿链收养、重编号、悬空依赖解析与移交冻结"
```

---

### Task 18: 工具注册面（schema、L1 预检、冲突自检、bg_* 与 verify）

**Files:**
- Create: `src/tool/schema.ts`, `src/tool/register.ts`
- Test: `tests/tool/schema.test.ts`, `tests/tool/register.test.ts`

**Interfaces:**
- Consumes: T1–T17
- Produces:
  - `TodoParamsSchema`, `BgRunParamsSchema`, `BgKillParamsSchema`（typebox）
  - `prepareTodoArguments(args: unknown): unknown`（修双重 JSON 编码）
  - `detectToolConflict(allTools: { name: string; sourceInfo?: { source?: string } }[], ownSource: string): boolean`
  - `createTodoTool(deps)` / `createBgRunTool(deps)` / `createBgListTool(deps)` / `createBgKillTool(deps)`
  - `preflight(event, state, ctx): { block: true; reason: string } | undefined`

- [ ] **Step 1: 写失败测试**

```ts
// tests/tool/schema.test.ts
import { expect, it } from "vitest";
import { prepareTodoArguments } from "../../src/tool/schema.js";

it("双重编码的 tasks[] 被解开（Review Focus 1）", () => {
  const raw = { action: "create", tasks: JSON.stringify([{ subject: "a" }, JSON.stringify({ subject: "b" })]) };
  const out = prepareTodoArguments(raw) as { tasks: { subject: string }[] };
  expect(out.tasks.map((t) => t.subject)).toEqual(["a", "b"]);
});

it("正常参数原样返回", () => {
  const raw = { action: "create", subject: "a" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});

it("非法 JSON 不抛，原样透传", () => {
  const raw = { action: "create", tasks: "{not json" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});
```

```ts
// tests/tool/register.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { detectToolConflict, preflight } from "../../src/tool/register.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 1, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("旧包占位时判定冲突（F13）", () => {
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:@juicesharp/rpiv-todo" } }], "npm:pi-kit")).toBe(true);
  expect(detectToolConflict([{ name: "todo", sourceInfo: { source: "npm:pi-kit" } }], "npm:pi-kit")).toBe(false);
  expect(detectToolConflict([], "npm:pi-kit")).toBe(false);
});

it("L1 预检拦明显违规并给文案", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  const r = preflight({ toolName: "todo", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx());
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain("WIP full");
});

it("L1 跳过嵌套调用（F15）", () => {
  const b = emptyBoard();
  b.tasks = [{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }];
  expect(preflight({ toolName: "todo", parentToolCallId: "p1", input: { action: "update", id: 2, status: "in_progress" } }, b, ctx())).toBeUndefined();
});

it("L1 不管别的工具（F14）", () => {
  expect(preflight({ toolName: "read", input: { path: "a" } }, emptyBoard(), ctx())).toBeUndefined();
});

it("畸形 input 不抛（Review Focus 1）", () => {
  expect(preflight({ toolName: "todo", input: null }, emptyBoard(), ctx())).toBeUndefined();
  expect(preflight({ toolName: "todo", input: { action: "update" } }, emptyBoard(), ctx())).toBeUndefined();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/tool`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 schema**

```ts
// src/tool/schema.ts
import { Type } from "typebox";

const StatusEnum = Type.Union([
  Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("parked"),
  Type.Literal("completed"), Type.Literal("deleted"),
]);
const VerifySpec = Type.Object({ kind: Type.Literal("command"), command: Type.String() });
const DeferSpec = Type.Object({ untilJob: Type.String(), reason: Type.String() });
const CreateItem = Type.Object({
  subject: Type.String(), description: Type.Optional(Type.String()), activeForm: Type.Optional(Type.String()),
  blockedBy: Type.Optional(Type.Array(Type.Number())), owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())), verify: Type.Optional(VerifySpec),
});

export const TodoParamsSchema = Type.Object({
  action: Type.Union(["create", "update", "list", "get", "delete", "clear", "verify"].map((a) => Type.Literal(a))),
  id: Type.Optional(Type.Number()),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  status: Type.Optional(StatusEnum),
  reason: Type.Optional(Type.String()),
  accept: Type.Optional(Type.Literal("stale")),
  blockedBy: Type.Optional(Type.Array(Type.Number())),
  addBlockedBy: Type.Optional(Type.Array(Type.Number())),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  tasks: Type.Optional(Type.Array(CreateItem)),
  includeDeleted: Type.Optional(Type.Boolean()),
  verify: Type.Optional(VerifySpec),
  defer: Type.Optional(Type.Union([DeferSpec, Type.Null()])),
  // 只读字段：声明在 schema 里供展示，但 reducer 会拒（R16）
  jobs: Type.Optional(Type.Array(Type.String())),
  evidence: Type.Optional(Type.Array(Type.Unknown())),
  lastFailure: Type.Optional(Type.Unknown()),
  inProgressSince: Type.Optional(Type.Number()),
  statusSince: Type.Optional(Type.Number()),
  verifyChanged: Type.Optional(Type.Boolean()),
});

export const BgRunParamsSchema = Type.Object({
  command: Type.String(), label: Type.Optional(Type.String()), task_id: Type.Optional(Type.Number()),
});
export const BgKillParamsSchema = Type.Object({ job_id: Type.String() });

const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export function prepareTodoArguments(args: unknown): unknown {
  if (!isBag(args) || args.tasks === undefined) return args;
  const decoded = typeof args.tasks === "string" ? tryParse(args.tasks) : args.tasks;
  if (!Array.isArray(decoded)) return args;
  const items = decoded.map((it) => (typeof it === "string" ? tryParse(it) ?? it : it));
  return { ...args, tasks: items };
}
```

- [ ] **Step 4: 实现 register 的可测部分**

```ts
// src/tool/register.ts
import { checkStructure, type MutationParams, type RuleContext } from "../board/invariants.js";
import type { BoardState } from "../board/types.js";

export function detectToolConflict(
  allTools: { name: string; sourceInfo?: { source?: string } }[], ownSource: string,
): boolean {
  const t = allTools.find((x) => x.name === "todo");
  if (!t) return false;
  return !(t.sourceInfo?.source ?? "").includes(ownSource);
}

/** L1：尽力而为的友好提示，跳过嵌套调用与非 todo 工具。 */
export function preflight(
  event: { toolName: string; input?: unknown; parentToolCallId?: string },
  state: BoardState, ctx: RuleContext,
): { block: true; reason: string } | undefined {
  if (event.toolName !== "todo" || event.parentToolCallId) return undefined;
  const input = event.input;
  if (typeof input !== "object" || input === null) return undefined;
  const p = input as MutationParams;
  if (p.action !== "update" || typeof p.id !== "number") return undefined;
  const task = state.tasks.find((t) => t.id === p.id);
  if (!task) return undefined;
  const reason = checkStructure(state, task, p as never, ctx);
  return reason ? { block: true, reason } : undefined;
}
```

工具工厂（`createTodoTool` 等）在本 Task 一并实现，但 pi 依赖注入为接口，测试用假 ctx：

```ts
export interface ToolDeps {
  sessionId(): string;
  board(): BoardState;
  commit(state: BoardState): void;
  appendEntry(type: string, data: unknown): void;
  ruleCtx(): RuleContext;
  jobs: import("../jobs/store.js").JobStore;
  cfg: import("../lib/config.js").VigilConfig;
  spawn(req: import("../jobs/spawn.js").SpawnRequest): { ok: boolean; error?: string; jobId?: string };
  kill(idOrRoot: string, by: "self" | "external"): void;
  runVerify(command: string): Promise<{ ok: boolean; exitCode: number | null }>;
  now(): number;
}
```

`createTodoTool(deps)` 的 `execute` 必须：同步 `applyMutation` → `commit` → `appendEntry("rpiv-todo-state", details)` → 返回 `buildResult`；`verify` action 走 `runVerify` 后写 `origin:"tool"` 证据再落快照。`createBgRunTool` 按规格 §7.8 三步（校验 → spawn → 提交），第 3 步抛错立即 kill。

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（8 例）

- [ ] **Step 6: Commit**

```bash
git add src/tool/schema.ts src/tool/register.ts tests/tool
git commit -m "feat(vigil-todo): 参数 schema、L1 预检、冲突自检与工具工厂"
```

---

### Task 19: 面板与命令（汇总行、parked reason、行预算）

**Files:**
- Create: `src/ui/panel.ts`, `src/ui/overlay.ts`
- Test: `tests/ui/panel.test.ts`, `tests/ui/overlay.test.ts`

**Interfaces:**
- Consumes: T1–T18
- Produces:
  - `renderPanel(state, jobs, cfg, opts?): string[]`
  - `renderTodos(state, jobs): string`
  - `renderDoctor(state, jobs, conflict: boolean, degraded?: string): string`
  - `layoutRows(state, jobs, budget): { rows: string[]; hiddenParked: number }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/ui/panel.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard, type Evidence, type Task } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { layoutRows, renderDoctor, renderPanel, renderTodos } from "../../src/ui/panel.js";

const ev = (o: Partial<Evidence> = {}): Evidence => ({
  ok: true, kind: "job", origin: "async", chainFinal: true, at: 1, known: true, fp: "fresh", exitCode: 0, ref: "R", ...o,
});
const done = (id: number, fp: "fresh" | "unknown" = "fresh"): Task =>
  ({ id, subject: `d${id}`, status: "completed", evidence: [ev({ fp, ref: `R${id}` })] });
const b = (tasks: Task[]) => ({ ...emptyBoard(), tasks, nextId: tasks.length + 1 });
const jobs = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-ui-")));

it("首行含 done/total 与 parked 数（F25）", () => {
  const s = b([done(1), { id: 2, subject: "p", status: "parked", park: { reason: "需拍板", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows[0]).toContain("1/2");
  expect(rows[0]).toContain("1 parked");
});

it("completed 汇总一行带证据与 fp:? 计数（F58）", () => {
  const s = b([done(1), done(2, "unknown"), done(3, "unknown")]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  const summary = rows.find((r) => r.includes("done ·"));
  expect(summary).toContain("3 done");
  expect(summary).toContain("all exit 0");
  expect(summary).toContain("2 条 fp:?");
});

it("parked reason 独占缩进行（F25）", () => {
  const s = b([{ id: 1, subject: "p", status: "parked", park: { reason: "公开 API 需拍板", at: 1, from: "pending" } }]);
  const rows = renderPanel(s, jobs(), DEFAULTS);
  expect(rows.some((r) => r.includes("└─ 公开 API 需拍板"))).toBe(true);
});

it("deferred 用 ⏸ 且显示 untilRoot", () => {
  const s = b([{ id: 1, subject: "d", status: "pending", defer: { untilRoot: "bg_x", reason: "冲突", at: 1 } }]);
  expect(renderPanel(s, jobs(), DEFAULTS).some((r) => r.includes("⏸") && r.includes("bg_x"))).toBe(true);
});

it("超预算优先保 parked，截断给出 +N more parked（F25）", () => {
  const tasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, subject: `p${i}`, status: "parked" as const, park: { reason: `r${i}`, at: 1, from: "pending" as const },
  }));
  const r = layoutRows(b(tasks), jobs(), 6);
  expect(r.hiddenParked).toBeGreaterThan(0);
  expect(r.rows.join("\n")).toContain("more parked");
  expect(r.rows[0]).toContain("10 parked");
});

it("空列表返回空数组（自动卸载）", () => {
  expect(renderPanel(emptyBoard(), jobs(), DEFAULTS)).toEqual([]);
});

it("/todos 逐条带 exit code 与 fp（F58 下钻）", () => {
  const text = renderTodos(b([done(1), done(2, "unknown")]), jobs());
  expect(text).toContain("#1");
  expect(text).toContain("exit 0");
  expect(text).toContain("fp:unknown");
});

it("doctor 报冲突与降级（F13/F12）", () => {
  const text = renderDoctor(emptyBoard(), jobs(), true, "sidecar 损坏");
  expect(text).toContain("冲突");
  expect(text).toContain("sidecar 损坏");
});
```

```ts
// tests/ui/overlay.test.ts
import { expect, it } from "vitest";
import { createOverlayController } from "../../src/ui/overlay.js";
import { emptyBoard } from "../../src/board/types.js";

it("headless 时全部 no-op（Review Focus 5）", () => {
  let calls = 0;
  const c = createOverlayController({ hasUI: () => false, setWidget: () => { calls++; }, render: () => ["x"] });
  c.update(emptyBoard());
  expect(calls).toBe(0);
});

it("空列表卸载 widget；非空注册", () => {
  const set: (string | undefined)[] = [];
  const c = createOverlayController({ hasUI: () => true, setWidget: (k) => { set.push(k); }, render: () => ["x"] });
  c.update(emptyBoard());
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  c.update(b);
  expect(set).toEqual([undefined, "vigil-todo"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/ui`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 panel**

```ts
// src/ui/panel.ts
import { completedSummary } from "../board/selectors.js";
import type { BoardState } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";

export const WIDGET_KEY = "vigil-todo";

export function layoutRows(state: BoardState, jobs: JobStore, budget: number) {
  const sum = completedSummary(state);
  const parked = state.tasks.filter((t) => t.status === "parked");
  const head = `● vigil-todo ${sum.done}/${sum.total}${parked.length ? ` · ⚠ ${parked.length} parked` : ""}`;
  const rows: string[] = [head];
  let used = 1;
  const summaryParts = [`${sum.done} done`, sum.allExit0 ? "all exit 0" : "有非零退出"];
  if (sum.fpUnknown) summaryParts.push(`⚠ ${sum.fpUnknown} 条 fp:?`);
  if (sum.reverified) summaryParts.push(`↺ ${sum.reverified} reverified`);
  if (sum.verifyChanged) summaryParts.push(`${sum.verifyChanged} verify changed`);
  if (sum.done > 0 && used < budget) { rows.push(`├─ ✓ ${summaryParts.join(" · ")}`); used++; }

  let hiddenParked = 0;
  for (const t of parked) {
    if (used + 2 > budget) { hiddenParked++; continue; }
    rows.push(`├─ ⚠ #${t.id} ${sanitizeTerminalText(t.subject)}  parked`);
    rows.push(`│    └─ ${sanitizeTerminalText(t.park?.reason ?? "")}`);
    used += 2;
  }
  for (const t of state.tasks.filter((x) => x.status === "in_progress")) {
    if (used >= budget) break;
    const running = jobs.all().find((j) => j.taskId === t.id && j.status === "running");
    const retry = running ? ` · ↻ retry ${running.attempt}/4` : "";
    rows.push(`├─ ◐ #${t.id} ${sanitizeTerminalText(t.subject)}${t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : ""}${retry}`);
    used++;
  }
  for (const t of state.tasks.filter((x) => x.defer)) {
    if (used >= budget) break;
    rows.push(`├─ ⏸ #${t.id} ${sanitizeTerminalText(t.subject)}  deferred → ${t.defer!.untilRoot}`);
    used++;
  }
  for (const t of state.tasks.filter((x) => x.status === "pending" && !x.defer)) {
    if (used >= budget) break;
    const dep = t.blockedBy?.length ? `  ⛓ ${t.blockedBy.map((d) => `#${d}`).join(",")}` : "";
    rows.push(`├─ ○ #${t.id} ${sanitizeTerminalText(t.subject)}${dep}`);
    used++;
  }
  if (hiddenParked) rows.push(`└─ +${hiddenParked} more parked`);
  else if (rows.length > 1) rows[rows.length - 1] = rows[rows.length - 1].replace("├─", "└─");
  return { rows, hiddenParked };
}

export function renderPanel(state: BoardState, jobs: JobStore, cfg: VigilConfig): string[] {
  if (state.tasks.every((t) => t.status === "deleted")) return [];
  return [...layoutRows(state, jobs, cfg.maxWidgetLines).rows, ""];
}

export function renderTodos(state: BoardState, _jobs: JobStore): string {
  return state.tasks.filter((t) => t.status !== "deleted").map((t) => {
    const fin = (t.evidence ?? []).filter((e) => e.chainFinal).at(-1);
    const ev = fin ? `  exit ${fin.exitCode ?? "?"} fp:${fin.fp}` : "";
    const park = t.park ? `  parked: ${t.park.reason}` : "";
    const defer = t.defer ? `  deferred → ${t.defer.untilRoot}` : "";
    return `[${t.status}] #${t.id} ${t.subject}${ev}${park}${defer}`;
  }).join("\n") || "No tasks";
}

export function renderDoctor(state: BoardState, jobs: JobStore, conflict: boolean, degraded?: string): string {
  const lines: string[] = [];
  if (conflict) lines.push("✗ todo 工具冲突：旧包未卸载，本扩展未注册事件处理器");
  if (degraded) lines.push(`✗ ${degraded}`);
  const orphanDefer = state.tasks.filter((t) => t.defer && !jobs.get(t.defer.untilRoot));
  if (orphanDefer.length) lines.push(`⚠ ${orphanDefer.length} 个 defer 目标已无记录`);
  const noEvidence = state.tasks.filter((t) => t.status === "in_progress" && (t.jobs?.length ?? 0) === 0);
  if (noEvidence.length) lines.push(`⚠ ${noEvidence.length} 个 in_progress 任务无绑定作业`);
  return lines.join("\n") || "✓ 未发现问题";
}
```

- [ ] **Step 4: 实现 overlay 控制器**

```ts
// src/ui/overlay.ts
import type { BoardState } from "../board/types.js";
import { WIDGET_KEY } from "./panel.js";

export interface OverlayHost {
  hasUI(): boolean;
  setWidget(key: string | undefined): void;
  render(): string[];
}

export function createOverlayController(host: OverlayHost) {
  let registered = false;
  return {
    update(state: BoardState) {
      if (!host.hasUI()) return;
      const visible = state.tasks.some((t) => t.status !== "deleted");
      if (!visible) { if (registered) { host.setWidget(undefined); registered = false; } return; }
      if (!registered) { host.setWidget(WIDGET_KEY); registered = true; }
    },
    dispose() { if (host.hasUI() && registered) host.setWidget(undefined); registered = false; },
    isRegistered: () => registered,
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: PASS（10 例）

- [ ] **Step 6: Commit**

```bash
git add src/ui tests/ui
git commit -m "feat(vigil-todo): 面板汇总行、parked reason、行预算与 headless no-op"
```

---

### Task 20: 扩展接线、性能基准、迁移文档与端到端冒烟

**Files:**
- Create: `extensions/vigil-todo.ts`, `tests/integration/smoke.test.ts`, `tests/perf/budget.test.ts`, `docs/migration.md`, `README.md`
- Modify: `package.json`（`pi.extensions` 已指向入口，补 `files`）

**Interfaces:**
- Consumes: T1–T19 全部
- Produces: 默认导出 `(pi: ExtensionAPI) => void`；可执行的性能基准与冒烟测试；迁移文档

- [ ] **Step 1: 写失败测试 — 性能预算**

```ts
// tests/perf/budget.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyMutation } from "../../src/board/reducer.js";
import { replayBranch } from "../../src/board/replay.js";
import { emptyBoard } from "../../src/board/types.js";
import { tailLines } from "../../src/lib/tail.js";
import type { RuleContext } from "../../src/board/invariants.js";

const ctx = (): RuleContext => ({
  wipLimit: 3, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});

it("200 任务下 1000 次 mutation p95 < 3ms", () => {
  let s = emptyBoard();
  for (let i = 0; i < 200; i++) s = applyMutation(s, { action: "create", subject: `t${i}` }, ctx()).state;
  const times: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    applyMutation(s, { action: "update", id: (i % 200) + 1, activeForm: `f${i}` }, ctx());
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(3);
});

it("1 万条分支 replay < 30ms", () => {
  const snap = { action: "update", params: {}, tasks: [{ id: 1, subject: "a", status: "pending" }], nextId: 2 };
  const entries = Array.from({ length: 10_000 }, () => ({ type: "custom", customType: "rpiv-todo-state", data: snap }));
  const t0 = performance.now();
  replayBranch(entries);
  expect(performance.now() - t0).toBeLessThan(30);
});

it("100MB 日志取 20 行 < 5ms（只读尾部）", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-perf-")), "huge.log");
  writeFileSync(p, Buffer.alloc(100 * 1024 * 1024, "x"));
  writeFileSync(p, "\nlast line\n", { flag: "a" });
  const t0 = performance.now();
  const out = tailLines(p, 20, 8192);
  expect(performance.now() - t0).toBeLessThan(5);
  expect(out.at(-1)).toBe("last line");
});
```

- [ ] **Step 2: 写失败测试 — 端到端冒烟**

```ts
// tests/integration/smoke.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { autofillJob } from "../../src/bind/autofill.js";
import { finalizeAndProject } from "../../src/bind/finalize.js";
import { sweepAll } from "../../src/bind/sweep.js";
import { applyMutation } from "../../src/board/reducer.js";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";
import { createMonitor } from "../../src/jobs/monitor.js";
import { spawnJob } from "../../src/jobs/spawn.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import { tryDeliver } from "../../src/wake/deliver.js";
import type { RuleContext } from "../../src/board/invariants.js";

it("真实作业 → 回填 → 终结 → 投影 → 投递（F4/F6/F72 闭环）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-smoke-"));
  const boards = createBoardStore(); const jobs = createJobStore(dir);
  const ctx = (): RuleContext => ({
    wipLimit: 3, now: Date.now(),
    facts: {
      hasRunning: (id) => jobs.all().some((j) => j.taskId === id && j.status === "running"),
      hasBackoff: (id) => jobs.all().some((j) => j.taskId === id && j.retryAt != null),
      startedAt: (ref) => jobs.get(ref)?.startedAt, exists: (id) => jobs.get(id) !== undefined,
    },
  });
  let s = emptyBoard();
  s = applyMutation(s, { action: "create", tasks: [{ subject: "跑测试" }, { subject: "写文档" }] }, ctx()).state;
  s = applyMutation(s, { action: "update", id: 1, status: "in_progress" }, ctx()).state;
  boards.commit("S", s);

  const r = spawnJob({ command: "printf 'ok\\n'", cwd: dir, taskId: 1, sessionId: "S" }, dir, Date.now());
  if (!r.ok) throw new Error(r.error);
  jobs.put(r.job); jobs.save();
  const mon = createMonitor();
  const exited = await new Promise<typeof r.job>((res) => mon.watch(r.job, res, r.child));
  jobs.put(exited); jobs.save();
  mon.clearAll();

  const deps = { boards, jobs, cfg: DEFAULTS, now: Date.now(), sessionId: "S",
    respawn: () => ({ ok: true }), notify: () => {}, isIdle: () => true };
  // 非 git 目录 ⇒ fp unknown ⇒ 仍自动完成（F35）
  expect(autofillJob(exited.id, deps).action).toBe("completed");
  finalizeAndProject(exited.rootId, jobs, boards, "S", Date.now(), "done", true);
  sweepAll(deps);

  const d = tryDeliver({ board: boards.get("S"), jobs, cfg: DEFAULTS, now: Date.now(),
    trigger: "async", modelAdvanced: true, capacityFull: false });
  expect(d.kind).toBe("deliver");
  if (d.kind !== "deliver") return;
  expect(d.text).toContain("next: #2");
  expect(boards.get("S").tasks[0].status).toBe("completed");
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -- tests/perf tests/integration`
Expected: FAIL — 模块/接线缺失

- [ ] **Step 4: 写扩展入口接线**

`extensions/vigil-todo.ts` 必须完成下列接线（每处都对应规格条款）：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// …import 各层…

export default function vigilTodo(pi: ExtensionAPI): void {
  // 1) 冲突自检（F13）：非自己 ⇒ notify error 且 **直接 return，不注册任何事件**
  // 2) 配置：~/.config/pi-kit/config.json → pi.getSettings().vigilTodo → .bgRun → DEFAULTS（mtime 缓存）
  // 3) 注册 todo / bg_run / bg_list / bg_kill（不设 executionMode）
  // 4) 注册 /vigil-todo（含 adopt / doctor 子命令）、/todos、/bg、折叠快捷键
  // 5) session_start：replay → recoverJobs → sweepAll → adoptOrphans → freezeMovedAway
  //    → writeHeartbeat；gate 失败挂一次性 +cfg.adoptRecheckMs 复查（F105）
  // 6) session_compact / session_tree：replay + sweep + 刷新
  // 7) session_shutdown：evict + removeHeartbeat + overlay.dispose（不杀作业）
  // 8) tool_call：preflight（跳过 parentToolCallId）
  // 9) tool_execution_end：todo/bg_* 后刷新 overlay；记录 modelAdvanced
  // 10) message_start / message_end：ackTracker.onMessage（F55）
  // 11) agent_start：ackTracker.onAgentStart（F61）
  // 12) agent_before_settle：tryDeliver("boundary")，DELIVER ⇒ {entries:[custom_message], continue:true}
  // 13) agent_settled：clearRenudgeOnSettled（F70）
  // 14) input：source ∈ {interactive,rpc} ⇒ resetOnUserInput（F65）
  // 15) 单 timer：仅当有 running 或 retryAt 时存在；职责 = 刷新 + sweepRespawns + sweepDefers
  //     + catchUpScan + adoptOrphans + writeHeartbeat；否则停表（§10.2）
}
```

接线完成后运行 `npm run typecheck` 必须通过；`pi -e ./extensions/vigil-todo.ts --print "列出工具"` 能加载不报错。

- [ ] **Step 5: 写迁移文档与 README**

`docs/migration.md` 必须写明：卸载两个旧包是**硬前置**（同名工具先注册者胜且静默）、兼容单向、`inProgressSince` fallback、配置键迁移、回滚不可行的原因。
`README.md` 写明安装、四条工具、三个命令、默认值表、北极星一句话。

- [ ] **Step 6: 全量验证**

Run: `npm test && npm run typecheck`
Expected: PASS（全部用例；perf 三项达标）

Run: `node -e "import('./extensions/vigil-todo.ts').catch(e=>{console.error(e);process.exit(1)})"` 若 jiti 不可用则改用 `pi -e ./extensions/vigil-todo.ts --print "ok"`
Expected: 加载成功

- [ ] **Step 7: 文档结构自检（F102）**

Run: `grep -c '^### Task' docs/superpowers/plans/2026-11-21-vigil-todo.md`
Expected: 20

Run: `grep -n 'TBD\|TODO\|待补' src extensions | head`
Expected: 无输出

- [ ] **Step 8: Commit**

```bash
git add extensions tests/integration tests/perf docs/migration.md README.md package.json
git commit -m "feat(vigil-todo): 扩展接线、性能基准、迁移文档与端到端冒烟"
```

---

## Self-Review

**1. 规格覆盖**：R1–R17 → T2/T3/T4/T18；F1–F105 逐条落到 T1–T20 的测试（映射见各 Task 标题与用例注释）；§5.2 指纹 → T11；§7.1 回填 → T12；§7.1.1 收养 → T17；§7.4 投递 → T15；§5.3 ack → T16；§8 面板 → T19；§10.2 性能 → T20；§11 迁移 → T5/T20。

**2. 占位符**：T8/T12/T14/T18 中三处「实现注」是**对计划内示例代码的纠正说明**（`SpawnResult` 显式接口、`classifyOverlap` 真实调用、`runDir` 而非 `cwd`、工具工厂 deps 接口），执行者必须按纠正后的写法实现，不得保留空壳。

**3. 类型一致性**：`JobFacts.startedAt` 在 T2 定义、T4/T12/T18 使用同名；`BoardCounters` 三字段在 T1 定义、T15/T16 一致；`AutofillDeps.respawn` 与 `SweepDeps.respawn` 同为 `(req: SpawnRequest) => { ok: boolean }`；`claim/release/takeoverStale` 首参统一为 **runDir**。

**4. Review Focus**：五类输入各自有测试 —— 畸形参数 T3/T18；外部破坏 T5/T7；重复事件 T8/T13/T14；时钟与文件系统 T6/T9/T10/T11；headless 与旧包共存 T18/T19。

## Execution Handoff

执行方式已由人指定：**build 实现 → check 审核代码 → piper 终审**。全部 Task 在 `feat/vigil-todo` 单分支完成，最终 PR 由人审核合并。
