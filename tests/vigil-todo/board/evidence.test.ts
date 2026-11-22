import { describe, expect, it } from "vitest";
import { completionGate, recordFailure } from "../../../src/vigil-todo/board/evidence.js";
import { EVIDENCE_RING, type Evidence, type Task } from "../../../src/vigil-todo/board/types.js";
import type { JobFacts } from "../../../src/vigil-todo/board/invariants.js";

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

describe("R3 completion requires evidence", () => {
  it("a task with no job and no verify has no requirements", () => {
    expect(completionGate({ id: 1, subject: "t", status: "in_progress" }, facts())).toBeUndefined();
  });
  it("has a job but no evidence → rejected", () => {
    expect(completionGate(task(), facts({ bg_a: 150 }))).toMatch(/no passing evidence/);
  });
  it("job evidence satisfies startedAt >= inProgressSince and at >= startedAt → allowed (F4)", () => {
    expect(completionGate(task({ evidence: [ev()] }), facts({ bg_a: 150 }))).toBeUndefined();
  });
  it("job started before this in_progress round → rejected (F42)", () => {
    expect(completionGate(task({ evidence: [ev()] }), facts({ bg_a: 50 }))).toMatch(/no passing evidence/);
  });
  it("verify evidence must also satisfy at >= inProgressSince (F51)", () => {
    const t = task({ jobs: undefined, verify: { kind: "command", command: "npm test" },
      evidence: [ev({ kind: "command", origin: "tool", ref: undefined, at: 50 })] });
    expect(completionGate(t, facts())).toMatch(/no passing evidence/);
  });
  it("inProgressSince=0 migrated state skips recency checks (F52)", () => {
    expect(completionGate(task({ inProgressSince: 0, evidence: [ev({ at: 10 })] }), facts({ bg_a: 5 }))).toBeUndefined();
  });
});

describe("R5/R6", () => {
  it("known:false does not count as passing (F5)", () => {
    expect(completionGate(task({ evidence: [ev({ known: false })] }), facts({ bg_a: 150 }))).toMatch(/no passing evidence/);
  });
  it("stale not accepted → rejected; accept:stale allows it (F20/F21)", () => {
    const t = task({ evidence: [ev({ fp: "stale" })] });
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/stale/);
    expect(completionGate(t, facts({ bg_a: 150 }), "stale")).toBeUndefined();
  });
  it("unknown does not block (F58)", () => {
    expect(completionGate(task({ evidence: [ev({ fp: "unknown" })] }), facts({ bg_a: 150 }))).toBeUndefined();
  });
});

describe("R2 failure blocks completion", () => {
  it("lastFailure with no later passing evidence → rejected (F3)", () => {
    const t = task({ evidence: [ev()] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/unresolved failure/);
  });
  it("lastFailure still blocks after ring overflow (F36)", () => {
    const t = task({ evidence: [] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    for (let i = 0; i < EVIDENCE_RING + 4; i++) t.evidence = [...(t.evidence ?? []), ev({ at: 100 + i })].slice(-EVIDENCE_RING);
    expect(t.evidence).toHaveLength(EVIDENCE_RING);
    expect(completionGate(t, facts({ bg_a: 150 }))).toMatch(/unresolved failure/);
  });
  it("newer passing evidence clears the block", () => {
    const t = task({ evidence: [ev({ at: 400 })] });
    recordFailure(t, { exitCode: 1, ref: "bg_a", at: 300 });
    expect(completionGate(t, facts({ bg_a: 150 }))).toBeUndefined();
  });
});
