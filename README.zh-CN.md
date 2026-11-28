[English](./README.md) | [中文](./README.zh-CN.md)

# pi-kit

一个 pi 扩展集合：一个仓库，一次安装，N 个扩展。

## 扩展

| 扩展 | 它做什么 | 文档 |
|---|---|---|
| `vigil-todo` | 任务板加后台作业：基于证据的完成判定、重试/退避、唤醒投递、一键 halt，以及主动的首次运行引导——告诉模型何时该用任务板。 | [docs/vigil-todo/README.md](docs/vigil-todo/README.md) |

`vigil-todo` 的子 agent 派发指引见 [docs/vigil-todo/dispatching-agents.md](docs/vigil-todo/dispatching-agents.md)。

## 安装

根据你的情况，有三种安装方式：

**git —— 现在即可使用，跟踪 `main`：**

```bash
pi install git:github.com/Spoon94/pi-kit
```

**npm —— 推荐使用者使用：**

```bash
pi install npm:@spoon94/pi-kit
```

**本地检出 —— 用于开发；代码改动通过 `/reload` 生效：**

```bash
pi install ./
```

如果想固定某个快照，可以指定 ref：`pi install git:github.com/Spoon94/pi-kit@<tag-or-sha>`。

按需调整 remote/fork，然后重启 pi。各扩展的文档描述了额外的设置步骤（例如 `vigil-todo` 要求先移除旧的 `rpiv-todo` / `pi-bg-run` 包）。

## 首次使用

在一个会话的第一次真实用户运行时，`vigil-todo` 会给模型一条简短的条件式指令：如果请求跨越 3 个以上步骤、多个文件或长时间运行的命令，先在动手前用 `todo create` 把工作记下来；长命令用 `bg_run` 运行；跳过琐碎问题（不为它们建任务）。同一会话中后续的运行不会重复收到这条消息，唤醒/自定义运行也从不触发它。系统提示还带有一句单行的引导语，外加一份轻量的任务板摘要（当前 WIP 和下一个任务），每当任务板变化时就会被替换。

用 `onboardingPrompt` 配置它：`live`（默认，消息 + 任务板摘要）、`once`（仅基础句子和首次运行消息）或 `off`（什么都没有）。工具细节见 [docs/vigil-todo/README.md](docs/vigil-todo/README.md)。

## 添加扩展

分步指南：[docs/adding-an-extension.md](docs/adding-an-extension.md)。

## 开发

```bash
npm install
npm test                 # vitest
npm run typecheck
npm run coverage:check   # lines >=95% / branches >=90% / functions >=95%
npm run verify           # test + typecheck + coverage in one shot
```

仓库约定：

- **仅限英文**：`src/`、`extensions/` 和 `tests/` 由 `tests/arch/language.test.ts` 守卫，禁止出现 CJK 字符；新文档以英文编写。
- **单一构建分支**：工作在一个构建分支上进行；每一轮都提交并推送；最终 PR 由人工审核。
- **真相来自持久状态**：运行时决策应读取权威的持久状态，而不是可被淘汰的展示数据。

## 布局

| 路径 | 职责 |
|---|---|
| `extensions/` | pi 扩展入口点（每个扩展一个薄 `.ts` 文件） |
| `src/` | 实现命名空间；每个扩展一个 `src/<name>/`（目前是 `src/vigil-todo/`） |
| `tests/` | Vitest 测试套件；每个扩展一个 `tests/<name>/`，外加仓库级的 `arch/` 和 `selfcheck/` 守卫 |
| `docs/` | 集合文档加每个扩展一个文件夹；各扩展的设计档案位于其自己的 `docs/<name>/design/` 下（vigil-todo：`docs/vigil-todo/design/`） |
