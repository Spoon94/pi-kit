import { READONLY_FIELDS, checkStructure, type MutationParams, type RuleContext } from "./invariants.js";
import { appendEvidence, completionGate } from "./evidence.js";
import { applyCleanup, planCleanup } from "./cleanup.js";
import { detectCycle, formatCycle } from "./graph.js";
import { isJsonSafe, verifyError } from "./json.js";
import type { BoardState, Status, Task } from "./types.js";

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
    if (!Number.isSafeInteger(state.nextId) || !Number.isSafeInteger(state.nextId + items.length)) {
      return err(state, "nextId overflow; id must stay a safe integer");
    }
    const sibling = new Set(items.map((_, i) => state.nextId + i));
    for (const [i, it] of items.entries()) {
      if (typeof it.subject !== "string" || it.subject.trim() === "") {
        return err(state, fromTasks ? `tasks[${i}]: subject required for create` : "subject required for create");
      }
      if (it.metadata !== undefined) {
        if (!isBag(it.metadata)) return err(state, "metadata must be an object");
        if (!isJsonSafe(it.metadata)) return err(state, "metadata must be JSON-safe (no cycles, depth ≤64, nodes ≤10000, finite numbers)");
      }
      if (it.verify !== undefined) {
        const bad = verifyError(it.verify);
        if (bad) return err(state, bad);
      }
      for (const dep of it.blockedBy ?? []) {
        if (!Number.isSafeInteger(dep)) return err(state, `blockedBy: #${String(dep)} must be a safe integer`);
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
      if (it.blockedBy?.length) t.blockedBy = [...new Set(it.blockedBy)];
      if (it.metadata) t.metadata = { ...it.metadata };
      if (it.verify) t.verify = { ...it.verify };
      return t;
    });
    const nextState: BoardState = {
      ...state, tasks: [...state.tasks, ...created], nextId: state.nextId + created.length,
    };
    // R21：create 的 blockedBy 并入图后做 DFS 环检测
    const cycle = detectCycle(nextState);
    if (cycle) {
      const head = created.find((t) => cycle.includes(t.id)) ?? created[0];
      return err(state, `create would create a cycle (${formatCycle(cycle)}) → todo({action:"update", id:${head.id}, removeBlockedBy:[…]})`);
    }
    return { state: nextState, op: { kind: "create", ids: created.map((t) => t.id) } };
  }

  if (p.action === "clear") {
    const plan = planCleanup(state, p.scope, p.force, ctx.facts);
    if (plan.error) return err(state, plan.error);
    return { state: applyCleanup(state, plan, ctx.now), op: { kind: "clear", count: plan.remove.length } };
  }
  if (p.action === "list") return { state, op: { kind: "list" } };

  if (p.id === undefined) return err(state, `id required for ${p.action}`);
  if (typeof p.id !== "number" || !Number.isSafeInteger(p.id)) return err(state, "id must be a safe integer");
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

  if (p.status === "parked" && (typeof p.reason !== "string" || p.reason.trim() === "")) {
    return err(state, `park requires reason → todo({action:"update", id:${cur.id}, status:"parked", reason:"…"})`);
  }
  if (p.reason !== undefined && p.status !== "parked") {
    return err(state, `reason is only valid with status:"parked" → todo({action:"update", id:${cur.id}, status:"parked", reason:"…"})`);
  }
  if (p.accept !== undefined && p.status !== "completed") {
    return err(state, `accept:"stale" is only valid with status:"completed"`);
  }
  if (p.verify !== undefined) {
    const bad = verifyError(p.verify);
    if (bad) return err(state, bad);
  }
  if (p.status === "completed" && p.verify !== undefined && p.verify.command !== cur.verify?.command) {
    return err(state, `#${cur.id} cannot change verify and complete in one update → 先改 verify，再 todo({action:"verify", id:${cur.id}})，最后 completed`);
  }
  if (p.status === "completed") {
    const gate = completionGate(cur, ctx.facts, p.accept);
    if (gate) return err(state, gate);
  }

  const mutable = p.subject !== undefined || p.description !== undefined || p.activeForm !== undefined
    || p.owner !== undefined || p.metadata !== undefined || p.status !== undefined
    || p.verify !== undefined
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
    if (!isJsonSafe(p.metadata)) return err(state, "metadata must be JSON-safe (no cycles, depth ≤64, nodes ≤10000, finite numbers)");
    const merged: Record<string, unknown> = { ...(cur.metadata ?? {}) };
    for (const [k, v] of Object.entries(p.metadata)) { if (v === null) delete merged[k]; else merged[k] = v; }
    set("metadata", Object.keys(merged).length ? merged : undefined);
  }
  if (p.removeBlockedBy?.length || p.addBlockedBy?.length) {
    const both = (p.addBlockedBy ?? []).filter((d) => (p.removeBlockedBy ?? []).includes(d));
    if (both.length) return err(state, `blockedBy id(s) ${both.map((d) => `#${d}`).join(" ")} cannot be both added and removed`);
    let deps = (cur.blockedBy ?? []).filter((d) => !(p.removeBlockedBy ?? []).includes(d));
    for (const d of p.addBlockedBy ?? []) {
      if (!Number.isSafeInteger(d)) return err(state, `addBlockedBy: #${String(d)} must be a safe integer`);
      if (d === cur.id) return err(state, `cannot block #${cur.id} on itself`);
      const t = state.tasks.find((x) => x.id === d);
      if (!t) return err(state, `addBlockedBy: #${d} not found`);
      if (t.status === "deleted") return err(state, `addBlockedBy: #${d} is deleted`);
      if (!deps.includes(d)) deps.push(d);
    }
    // R21：addBlockedBy 的提议边并入图后做 DFS 环检测（三节点以上环不能靠逐对比较）
    if (p.addBlockedBy?.length) {
      const cycle = detectCycle(state, { taskId: cur.id, deps });
      if (cycle) {
        const dep = p.addBlockedBy[0];
        return err(state,
          `#${cur.id} addBlockedBy[${dep}] would create a cycle (${formatCycle(cycle)})`
          + ` → todo({action:"update", id:${cur.id}, removeBlockedBy:[${dep}]})`);
      }
    }
    set("blockedBy", deps.length ? deps : undefined);
  }
  if (p.status !== undefined && p.status !== cur.status) {
    next.status = p.status;
    next.statusSince = ctx.now;
    if (p.status === "in_progress") next.inProgressSince = ctx.now;
    changed = true;
  }
  if (p.status === "parked") { next.park = { reason: p.reason!.trim(), at: ctx.now, from: cur.status }; changed = true; }
  if (p.status !== undefined && p.status !== "parked" && cur.park) { delete next.park; changed = true; }
  if (p.status === "completed" && p.accept === "stale") {
    const evidence = [...(next.evidence ?? [])];
    for (let i = evidence.length - 1; i >= 0; i--) {
      if (evidence[i].fp === "stale") { evidence[i] = { ...evidence[i], accepted: true }; changed = true; break; }
    }
    next.evidence = evidence;
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
  const tasks = [...state.tasks];
  tasks[idx] = next;
  return { state: { ...state, tasks }, op: { kind: "update", id: cur.id, from: cur.status, to: next.status, changed } };
}
