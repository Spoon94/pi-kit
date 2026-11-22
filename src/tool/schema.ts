import { Type } from "typebox";

const StatusEnum = Type.Union([
  Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("parked"),
  Type.Literal("completed"), Type.Literal("deleted"),
], { description: "目标状态。completed 需真实证据；parked 需 reason；deleted 是终态。" });

const VerifySpec = Type.Object({
  kind: Type.Literal("command", { description: "验证方式，目前仅支持 command。" }),
  command: Type.String({ description: "幂等验证命令，由 todo({action:\"verify\"}) 执行。" }),
}, { description: "任务的验证命令；改动会留 manual 证据并禁用自动完成。" });

const CreateItem = Type.Object({
  subject: Type.String({ description: "任务标题（必填，非空）。" }),
  description: Type.Optional(Type.String({ description: "任务详情/验收说明。" })),
  activeForm: Type.Optional(Type.String({ description: "进行中时面板显示的短语（如 writing tests）。" })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "依赖的任务 id 列表；依赖未 completed/deleted 时不可推进。" })),
  owner: Type.Optional(Type.String({ description: "任务负责人（自由文本）。" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "任意结构化元数据；值为 null 表示删除该键。" })),
  verify: Type.Optional(VerifySpec),
}, { description: "批量创建时的单条任务。" });

export const TodoParamsSchema = Type.Object({
  action: Type.Union(["create", "update", "list", "get", "delete", "clear", "verify"].map((a) => Type.Literal(a)), {
    description: "create 建任务；update 改字段/状态；list 列表；get 详情；delete 删除；clear 清理；verify 重验。",
  }),
  id: Type.Optional(Type.Number({ description: "目标任务 id；update/get/delete/verify 必填。" })),
  subject: Type.Optional(Type.String({ description: "标题。create 必填（或用 tasks[]）；update 可改。" })),
  description: Type.Optional(Type.String({ description: "任务详情。" })),
  activeForm: Type.Optional(Type.String({ description: "进行中短语，面板展示。" })),
  owner: Type.Optional(Type.String({ description: "负责人。" })),
  status: Type.Optional(StatusEnum),
  reason: Type.Optional(Type.String({ description: "park 的原因（必填）；也用于清理说明。" })),
  accept: Type.Optional(Type.Literal("stale", { description: "显式接受 stale 证据完成；会留痕。" })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "create 时的完整依赖 id 列表。" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "append 依赖；会做环检测 R21，成环即拒。" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "移除依赖 id（环/阻塞的出口）。" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "结构化元数据；值为 null 删除键。" })),
  tasks: Type.Optional(Type.Array(CreateItem, { description: "批量创建；与 subject 互斥。" })),
  includeDeleted: Type.Optional(Type.Boolean({ description: "list 时包含 deleted tombstone；默认隐藏。" })),
  scope: Type.Optional(Type.Union(["completed", "deleted", "settled", "all"].map((s) => Type.Literal(s)), {
    description: "clear 范围：completed/deleted/settled（默认）/all（需 force）。",
  })),
  force: Type.Optional(Type.Boolean({ description: "scope:\"all\" 必须为 true，且无 running/退避链。" })),
  verify: Type.Optional(VerifySpec),
  // 只读字段：声明在 schema 里供展示，但 reducer 会拒（R16）
  jobs: Type.Optional(Type.Array(Type.String(), { description: "只读：绑定作业 id；模型不可传。" })),
  evidence: Type.Optional(Type.Array(Type.Unknown(), { description: "只读：证据环形缓冲；模型不可传。" })),
  lastFailure: Type.Optional(Type.Unknown({ description: "只读：最近失败；模型不可传。" })),
  inProgressSince: Type.Optional(Type.Number({ description: "只读：本轮开工时间；模型不可传。" })),
  statusSince: Type.Optional(Type.Number({ description: "只读：状态变更时间；模型不可传。" })),
  verifyChanged: Type.Optional(Type.Boolean({ description: "只读：verify 命令是否改过；模型不可传。" })),
}, { description: "任务板统一入口；只增 verify action，其余意图走 update + 字段。" });

export const BgRunParamsSchema = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令（必填）。长任务用它而非 bash。" }),
  label: Type.Optional(Type.String({ description: "作业短标签，用于面板与唤醒消息。" })),
  task_id: Type.Optional(Type.Number({ description: "绑定任务 id；仅当前唯一 in_progress 时可省。" })),
}, { description: "启动后台作业并绑定任务；成功后再推进状态。" });

export const BgKillParamsSchema = Type.Object({
  job_id: Type.String({ description: "作业 id 或链上任意 id；会中止整条重试链。" }),
}, { description: "中止整条作业链（含 running 与退避）。" });

export const BgListParamsSchema = Type.Object({}, { description: "列出后台作业与退出码。" });

const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export function prepareTodoArguments(args: unknown): unknown {
  if (!isBag(args) || args.tasks === undefined) return args;
  const decoded = typeof args.tasks === "string" ? tryParse(args.tasks) : args.tasks;
  if (!Array.isArray(decoded)) return args;
  const items = decoded.map((it) => (typeof it === "string" ? tryParse(it) ?? it : it));
  return { ...args, tasks: items };
}
