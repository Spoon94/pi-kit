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
