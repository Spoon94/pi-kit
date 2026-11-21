import { READONLY_FIELDS, checkStructure, type MutationParams, type RuleContext } from "./invariants.js";
import { emptyBoard, type BoardState, type Status, type Task } from "./types.js";

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

export function applyMutation(state: BoardState, p: MutationParams, ctx: RuleContext): ApplyResult {
  if (p.action === "create") {
    if (p.subject !== undefined && p.tasks !== undefined) return err(state, "create requires subject or tasks[], not both");
    const fromTasks = p.tasks !== undefined;
    const items = p.tasks ?? (p.subject !== undefined ? [{ subject: p.subject, description: p.description, activeForm: p.activeForm, blockedBy: p.blockedBy, owner: p.owner, metadata: p.metadata, verify: p.verify }] : []);
    if (items.length === 0) return err(state, "subject required for create");
    const sibling = new Set(items.map((_, i) => state.nextId + i));
    for (const [i, it] of items.entries()) {
      if (typeof it.subject !== "string" || it.subject.trim() === "") {
        return err(state, fromTasks ? `tasks[${i}]: subject required for create` : "subject required for create");
      }
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

  const mutable = p.subject !== undefined || p.description !== undefined || p.activeForm !== undefined
    || p.owner !== undefined || p.metadata !== undefined || p.status !== undefined
    || (p.addBlockedBy?.length ?? 0) > 0 || (p.removeBlockedBy?.length ?? 0) > 0;
  if (!mutable) return err(state, `no mutable fields for ${p.action}`);

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
