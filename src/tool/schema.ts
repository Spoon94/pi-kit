import { Type } from "typebox";

const StatusEnum = Type.Union([
  Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("parked"),
  Type.Literal("completed"), Type.Literal("deleted"),
], { description: "Target status. completed needs real evidence; parked needs reason; deleted is terminal." });

const VerifySpec = Type.Object({
  kind: Type.Literal("command", { description: "Verification method; currently only command is supported." }),
  command: Type.String({ description: "Idempotent verification command, run by todo({action:\"verify\"})." }),
}, { description: "Task verification command; changes leave manual evidence and disable auto-completion." });

const CreateItem = Type.Object({
  subject: Type.String({ description: "Task subject (required, non-empty)." }),
  description: Type.Optional(Type.String({ description: "Task details/acceptance notes." })),
  activeForm: Type.Optional(Type.String({ description: "Phrase shown on the panel while in progress (e.g. writing tests)." })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency task ids; cannot advance until they are completed/deleted." })),
  owner: Type.Optional(Type.String({ description: "Task owner (free text)." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary structured metadata; a null value deletes that key." })),
  verify: Type.Optional(VerifySpec),
}, { description: "One task in a batch create." });

export const TodoParamsSchema = Type.Object({
  action: Type.Union(["create", "update", "list", "get", "delete", "clear", "verify"].map((a) => Type.Literal(a)), {
    description: "create makes a task; update changes fields/status; list lists; get shows details; delete deletes; clear clears; verify reverifies.",
  }),
  id: Type.Optional(Type.Number({ description: "Target task id; required for update/get/delete/verify." })),
  subject: Type.Optional(Type.String({ description: "Subject. Required for create (or use tasks[]); mutable by update." })),
  description: Type.Optional(Type.String({ description: "Task details." })),
  activeForm: Type.Optional(Type.String({ description: "In-progress phrase shown on the panel." })),
  owner: Type.Optional(Type.String({ description: "Owner." })),
  status: Type.Optional(StatusEnum),
  reason: Type.Optional(Type.String({ description: "Park reason (required; only with status:\"parked\")." })),
  accept: Type.Optional(Type.Literal("stale", { description: "Explicitly accept stale evidence to complete; this is logged." })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Full dependency id list for create." })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Append dependencies; runs R21 cycle detection and rejects cycles." })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Remove dependency ids (the way out of a cycle/block)." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Structured metadata; a null value deletes a key." })),
  tasks: Type.Optional(Type.Array(CreateItem, { description: "Batch create; mutually exclusive with subject." })),
  includeDeleted: Type.Optional(Type.Boolean({ description: "Include deleted tombstones in list; hidden by default." })),
  scope: Type.Optional(Type.Union(["completed", "deleted", "settled", "all"].map((s) => Type.Literal(s)), {
    description: "Clear scope: completed/deleted/settled (default)/all (requires force).",
  })),
  force: Type.Optional(Type.Boolean({ description: "Must be true for scope:\"all\", and no running/backoff chains." })),
  verify: Type.Optional(VerifySpec),
  // Read-only fields: declared in the schema for display, but the reducer rejects them (R16)
  jobs: Type.Optional(Type.Array(Type.String(), { description: "Read-only: bound job ids; the model cannot pass this." })),
  evidence: Type.Optional(Type.Array(Type.Unknown(), { description: "Read-only: evidence ring buffer; the model cannot pass this." })),
  lastFailure: Type.Optional(Type.Unknown({ description: "Read-only: last failure; the model cannot pass this." })),
  inProgressSince: Type.Optional(Type.Number({ description: "Read-only: start time for the current run; the model cannot pass this." })),
  statusSince: Type.Optional(Type.Number({ description: "Read-only: status change time; the model cannot pass this." })),
  verifyChanged: Type.Optional(Type.Boolean({ description: "Read-only: whether the verify command changed; the model cannot pass this." })),
}, { description: "Unified task board entry; only the verify action was added, other intents use update + fields." });

export const BgRunParamsSchema = Type.Object({
  command: Type.String({ description: "Shell command to run (required). Use this instead of bash for long tasks." }),
  label: Type.Optional(Type.String({ description: "Short job label for the panel and wake messages." })),
  task_id: Type.Optional(Type.Number({ description: "Bound task id; may be omitted only when exactly one task is in_progress." })),
}, { description: "Start a background job bound to a task; advance status only after success." });

export const BgKillParamsSchema = Type.Object({
  job_id: Type.String({ description: "Job id or any id on the chain; aborts the whole retry chain." }),
}, { description: "Abort the whole job chain (including running and backoff)." });

export const BgListParamsSchema = Type.Object({}, { description: "List background jobs and exit codes." });

const isBag = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export function prepareTodoArguments(args: unknown): unknown {
  if (!isBag(args) || args.tasks === undefined) return args;
  const decoded = typeof args.tasks === "string" ? tryParse(args.tasks) : args.tasks;
  if (!Array.isArray(decoded)) return args;
  const items = decoded.map((it) => (typeof it === "string" ? tryParse(it) ?? it : it));
  return { ...args, tasks: items };
}
