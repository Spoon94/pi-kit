# P0 · 假设验证结论

> 取证方式：阅读 pi 1.5.2 的 `dist/` 实现（非文档、非猜测）
> 根路径 `P = /usr/local/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`
> 结论：**四个假设全部证实，其中两个推翻了原设计**。另有两个附带发现。

---

## Q1 · 同名工具冲突 → **先注册者胜，静默忽略后来者**

```js
// P/dist/core/extensions/runner.js:410-421
/** Get all registered tools from all extensions (first registration per name wins). */
getAllRegisteredTools() {
    const toolsByName = new Map();
    for (const ext of this.extensions) {
        for (const tool of ext.tools.values()) {
            if (!toolsByName.has(tool.definition.name)) {   // ← 已存在就跳过
                toolsByName.set(tool.definition.name, tool);
            }
        }
    }
    return Array.from(toolsByName.values());
}
```

`getToolDefinition()`（`runner.js:423-432`）同样返回第一个匹配。

**加载顺序**（`P/dist/core/extensions/loader.js:671-700`）：

1. 项目 `.pi/extensions/`
2. 全局 `~/.pi/agent/extensions/`
3. `settings.packages` 的**声明顺序**

当前 `~/.pi/agent/settings.json` 里 `@juicesharp/rpiv-todo` 排第 3，`pi-bg-run` 排第 7。

### 后果（推翻原设计的"装上就能覆盖"假设）

- 把 `pi-kit` **追加**到 packages 末尾 → `todo` 仍由 rpiv-todo 提供，我们的 `todo` **被静默丢弃**，没有任何报错或警告。
- 更糟：`tool_call` / `tool_result` 事件是**广播**给所有扩展的，两个包都在。于是会出现「rpiv-todo 的 reducer 在写状态，pi-kit 的预检在拦截」的**半生效**状态——比完全不生效更难排查。

### 设计改动

1. 迁移步骤从"建议移除旧包"升级为**必须移除**，且要在文档里写成硬前置条件。
2. `session_start` 自检升级为**硬告警**：`pi.getAllTools()` 找 `todo` 的 `sourceInfo`，不是自己就 `notify(..., "error")` 并**放弃注册自己的事件处理器**（避免半生效）。
3. `/wip doctor` 把这一项列为第一条检查。

---

## Q2 · `ctx.settings` → **不存在，恒为 `undefined`**

`createContext()` 返回的对象**逐字段列举**，没有 `settings`：

```
P/dist/core/extensions/runner.js:621-695
  ui / mode / hasUI / cwd / sessionManager / modelRegistry / model /
  scopedModels / thinkingLevel / isIdle / isProjectTrusted / signal /
  abort / hasPendingMessages / shutdown / getContextUsage / compact / getSystemPrompt
```

- `createToolContext()`（`:704-730`）只额外加 `tools` + `executeTool`。
- `createCommandContext()`（`:731-766`）只额外加 session 控制方法。
- 三处都没有 `settings`。类型定义同样没有（`P/dist/core/extensions/types.d.ts:233-273`）。

正确入口是 `pi.getSettings()`（`types.d.ts:1330` → `agent-session.js:2897`）。

### 后果（证实旧包的 bug）

`pi-bg-run/index.js:806` 的 `ctx.settings?.bgRun` 永远是 `undefined` → `loadConfig(undefined, runDir)` 全部走 DEFAULTS。**它 README 里那张配置表（`maxConcurrentJobs` / `completedTtlMs` / `widgetRefreshMs` / `killTimeoutMs`）从来没有生效过。**

### 设计改动

配置读取链固定为：`~/.config/pi-kit/config.json` → `pi.getSettings().wip` → `pi.getSettings().bgRun`（旧键兼容）→ 默认值。**不碰 `ctx.settings`**。

---

## Q4 · `agent_before_settle` 的 `continue` → **不是一次性的，是 while 循环**

```js
// P/dist/core/agent-session.js:1514-1526
await this.agent.prompt(messages);
while (!this._agentRunAbortRequested) {
    if (await this._handlePostAgentRun()) { … await this.agent.continue(); continue; }
    if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))
        break;
    if (this._agentRunAbortRequested) break;
    await this.agent.continue();      // ← 回到 while 顶部，boundary 会再次触发
}
```

**每一轮 `agent.continue()` 之后都会重新触发 `agent_before_settle`。** 文档里的 "request one continuation" 指的是"每次 boundary 调用一次"，不是"整个 run 只准一次"。

### 后果（推翻原设计里"每轮最多一次"是可选优化的定位）

若 handler 无条件 `return {continue:true}` → **无限循环**，模型会被反复唤醒直到 abort 或上下文爆掉。这个闸门是**正确性必需**，不是防抖优化。

### 附带约束：`continue:true` 单独给是无效的

```js
// P/dist/core/agent-session.js:675-687
const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
canContinue: contextCanContinue || pendingCustomContext || …
```

```js
// P/dist/core/agent-session.js:1636-1647
this._commitBoundaryDrafts(result.entries);          // 先提交我们追加的 entries
const finalContext = this._buildBoundaryContext([], "agent_before_settle");
const shouldContinue = result.continue || this.agent.hasQueuedMessages();
if (shouldContinue && !finalContext.canContinue) {
    if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
    return false;                                    // ← 续跑被丢弃 + 报错
}
```

正常一轮结束时最后一条是 assistant 文本 → `finalRole === "assistant"` → `canContinue:false`。
但 custom message 在 LLM 投影里是 **user 角色**：

```js
// P/dist/core/messages.js:89-96
case "custom": {
    const content = typeof m.content === "string" ? [{type:"text", text:m.content}] : m.content;
    return { role: "user", content, timestamp: m.timestamp };
}
```

所以**必须同时追加一条 `custom_message` entry**，把 `finalRole` 翻成 `user`，`continue:true` 才被接受。

### 设计改动（§5.3 重写）

- 唤醒 entry 与 `continue:true` **必须成对**出现，缺一不可。
- 加**一次性闩锁**：`wakeLatch` 在请求续跑时置位，只有新证据到达才清除；`agent_start` 也清一次。
- 错误处理已天然安全：`emitBoundary` 捕获 handler 异常并 `emitError`，不会打断 run（`runner.js:788-796`）。
- 另注：`entries` 校验失败会导致 `{entries:[], continue:false, valid:false}`（`runner.js:810-812`），整批被丢弃 —— 追加的 entry 结构必须严格合法。

---

## Q5 · `executeTool` 权限路径 → **走同一套钩子，但必须有 assistant 消息**

```js
// P/dist/core/agent-session.js:442-470
async _executeNestedToolCall(parentToolCallId, name, args, options) {
    … runToolCall(toolCall, {
        beforeToolCall: (context) => this._beforeToolCall(context, parentId),   // ← 发 tool_call
        afterToolCall:  (context) => this._afterToolCall(context, parentId),    // ← 发 tool_result
        …
    })
}
```

`_beforeToolCall`（`:381-401`）就是 `emitToolCall`，权限是由注册了 `tool_call` 的扩展实现的 → **嵌套调用同样受权限约束**，符合预期。

### 但有一个硬前置

```js
// P/dist/core/agent-session.js:446-453
const assistantMessage = this._findLastAssistantMessage();
if (!assistantMessage) {
    return { …, result: { content:[{type:"text", text:"No assistant message issued this call"}] }, isError: true };
}
```

**没有"当前模型发起的工具调用"上下文时，`executeTool` 直接失败。**

### 后果

- `todo verify` 在 `todo.execute()` 里跑 → ✅ 有 assistant 消息，可用。
- 想在 `onExit`（作业完成回调）里**自动跑验证命令** → ❌ 没有 assistant 消息，也没有 tool ctx。**此路不通**。
- 想在 `/wip` 命令里跑验证 → ❌ 同理（command ctx 没有 `executeTool`）。

### 设计改动

- 自动回填**只用作业退出码**作证据，绝不在回调里跑命令。
- 失败后需要重验时，唤醒消息里明确指示模型调 `todo verify`（由模型发起 → 有上下文）。
- 我们自己的 `tool_call` 预检必须**跳过带 `parentToolCallId` 的嵌套调用**，否则 `verify` 内部的 bash 会被自己再拦一遍。

---

## 附带发现 A · `executionMode:"sequential"` 会串行化**整个批次**

```js
// P/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:374-378
const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential");
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(…);
}
```

只要批次里**有一个** `todo`，整批（含并行的 `read`/`grep`）都变串行。

而顺序模式下 `prepareToolCall`（即 `tool_call` 预检）是**逐个紧邻执行**的（`agent-loop.js:380-405`），所以预检能看到前一个调用的结果。

### 权衡与改动

- **正确性不依赖它**：我们的 `execute()` 从读快照到提交快照全程同步、无 `await`，JS 单线程 ⇒ 并行模式下两个 `update` 的临界区也不会交错。R1 恒成立。
- 它只买到「顺序确定性」+「预检可靠」，代价是**拖慢含 todo 的整个批次**。
- 因此：**默认不设 `executionMode`**，改为配置项 `sequentialTodo`（默认 `false`）。L2 提交校验是唯一权威，L1 预检降级为"尽力而为的友好提示"。

## 附带发现 B · 事件是广播，工具是独占

Q1 的另一面：`registerTool` 同名冲突是"先到先得"，但 `pi.on(...)` 是**所有扩展都收到**。任何"装上新包就自动接管"的想法都不成立，必须显式卸载旧包。这条已并入 Q1 的设计改动。

---

## 结论汇总

| 问题 | 结论 | 对设计的影响 |
|---|---|---|
| Q1 同名工具 | 先注册者胜，静默 | **必须卸载旧包**；自检失败则不注册事件 |
| Q2 `ctx.settings` | 不存在 | 用 `pi.getSettings()`；旧包配置表是死的 |
| Q4 `continue` | while 循环，可无限 | **闩锁是正确性必需**；必须配 `custom_message` entry |
| Q5 `executeTool` | 需 assistant 消息 | 回调里不能跑命令；预检跳过嵌套调用 |
| A `sequential` | 串行整批 | 默认关闭，降级为可选 |
| B 事件广播 | 与工具独占相反 | 强化"必须卸载"的结论 |

**下一步**：P1 可以直接开工，四个阻塞点已全部澄清，且没有需要运行时 spike 才能回答的问题了。
