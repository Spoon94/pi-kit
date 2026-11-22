# 派发子 agent 的正确姿势与边界

适用范围：用 `bg_run` 包一层「派发子 agent + 等报告」的 watcher（例如 `herdr agent prompt ...`）。核心原则：**把跨进程调用写成幂等的 poller，而不是一次性派发**。

## 1. 两步原子流程

```
todo({action:"create", subject:"…"})          # 1) 建任务，保持 pending
bg_run({task_id:<id>, command:"<派发+等报告>"}) # 2) 起 watcher
```

- **不要手动先 `todo({action:"update", id, status:"in_progress"})`。**
  `bg_run` 明确接受 `pending` 任务：先校验结构/容量，再 spawn，成功后在同一同步块内
  「绑定 job → pending 改 in_progress → 落快照」；绑定失败会 kill 刚 spawn 的 job
  （`src/tool/register.ts` 的 bg_run 实现）。手动多做一步，会把原子性拆成三个可各自失败的步骤。
- `task_id` 只有在恰好一个 in_progress 任务时可省略；用 pending 任务时请显式传。
- 失败方向：容量不足时任务保持 pending（不 park），按错误提示 `bg_kill` 释放或稍后重试。

## 2. 幂等 poller 模式

watcher 的 `command` 必须可被安全重跑——vigil-todo 会在 watcher 失败时按重试策略重跑同一条命令（默认总尝试 6 次）。推荐结构：

1. **非阻塞派发**：`herdr agent prompt …`（**不带 `--wait`**），派发后立即返回；
2. **轮询持久报告文件**：报告写到固定路径，watcher 循环 `sleep` + 检查文件，读到后以报告状态退出。

```sh
# 示意；具体 CLI 以你的 herdr 版本为准
herdr agent prompt build "…"            # 非阻塞派发，不带 --wait
while [ ! -f /tmp/…/report.json ]; do sleep 5; done
cat /tmp/…/report.json
```

因为报告文件持久存在，watcher 被杀后重跑同一条命令只会**重新挂上已有的 agent/报告**，
不会重复派活。反过来，如果 command 直接是一次性派发（无 poller），任何重跑都会重复派发。

## 3. 语义落差：halt 只杀 watcher

`/vt halt`、`alt+h`、`bg_kill` 杀的是 **watcher 进程**，**杀不了独立 agent 本体**。
按了 alt+h 不等于 build 停了；agent 可能仍在跑。要停 agent，用 agent 自己的控制面
（如 `herdr agent …`），不要把 vigil-todo 的 halt 当成子 agent 的刹车。

## 4. 残余风险与恢复

- **跨进程无事务**：watcher 与 agent 之间没有事务边界；watcher 被杀后 agent 仍会跑完，且无人观测。
- **检测**：`/vt doctor` 会报「N 个 in_progress 任务无绑定作业（如 #id）」；`bg_list` 可看作业终态。
- **恢复**：
  - 手动重跑同一个 poller 命令（幂等，重新挂上报告文件）；
  - 或用 `todo({action:"verify", id})` 让 `task.verify.command` 重新取证。
- **不做自动重挂**：watcher 被 kill 后 vigil-todo 不会自动重跑 command。原因：command 可能是
  「派发 + 等待」的派发者（例如 `herdr agent prompt build …`），自动重跑等于重复派活；
  vigil-todo 无法区分幂等等待者与非幂等派发者。**这正是要求 poller 模式的原因。**

## 5. fp:stale 在这类作业上是预期

子 agent 会改文件，`fpStart` 与 `fpEnd` 不同 ⇒ `fp:stale` 是常态，不是故障。
请在任务上设置 `task.verify.command`（真实测试套件）；autofill 会自动触发重验并真实执行该命令，
用证据而不是指纹来确认完成。已确认的预期改动也可以用 `accept:"stale"` 显式豁免。
