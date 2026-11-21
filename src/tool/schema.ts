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
