import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import type { Job } from "../../../src/vigil-todo/jobs/types.js";
import { ackByWakeId, ackPendingBoundary, clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../../../src/vigil-todo/wake/ack.js";
import { WAKE_CUSTOM_TYPE } from "../../../src/vigil-todo/wake/compose.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-ack-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending", ...o,
});

it("markSent writes only the root record (F89)", () => {
  const s = store();
  s.put(j("R")); s.put(j("M", { rootId: "R" }));
  markSent(s, ["R"], "w1", 100);
  expect(s.get("R")).toMatchObject({ notifyState: "sent", wakeId: "w1", notifySentAt: 100 });
  expect(s.get("M")?.notifyState).toBe("pending");
});

it("message path acks in bulk by wakeId (F55)", () => {
  const s = store();
  s.put(j("R")); s.put(j("R2"));
  markSent(s, ["R", "R2"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, WAKE_CUSTOM_TYPE, "w1")).toBe(2);
  expect(s.get("R")?.notifyState).toBe("acked");
  expect(s.get("R2")?.notifyState).toBe("acked");
});

it("mismatched customType / wakeId does not ack", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, "other", "w1")).toBe(0);
  expect(t.onMessage(s, WAKE_CUSTOM_TYPE, "wX")).toBe(0);
});

it("boundary path acks via the immediately following agent_start (F61)", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(t.onAgentStart(s, "S")).toBe(1);
  expect(s.get("R")?.notifyState).toBe("acked");
});

it("boundary entries dropped ⇒ no agent_start ⇒ stays sent (F71)", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(s.get("R")?.notifyState).toBe("sent");
});

it("settle clears waiting; a later unrelated agent_start does not ack by mistake (BLOCKER)", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  t.onSettled();
  expect(t.onAgentStart(s, "S")).toBe(0);
  expect(s.get("R")?.notifyState).toBe("sent");
});

it("ack is idempotent; repeated ack is not double-counted", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  expect(ackByWakeId(s, "w1")).toBe(1);
  expect(ackByWakeId(s, "w1")).toBe(0);
});

it("user input resets turnsUsed to zero (F65)", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 49, wakeWatermark: 500, renudgeBudget: 1 };
  expect(resetOnUserInput(b.counters)).toEqual({ turnsUsed: 0, wakeWatermark: 500, renudgeBudget: 1 });
});

it("agent_settled zeroes renudgeBudget (F70)", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 3, wakeWatermark: 500, renudgeBudget: 1 };
  expect(clearRenudgeOnSettled(b.counters).renudgeBudget).toBe(0);
});

it("ackPendingBoundary acks only roots sent in this session", () => {
  const s = store();
  s.put(j("R", { notifyState: "sent", sessionId: "S" }));
  s.put(j("OTHER", { notifyState: "sent", sessionId: "OTHER" }));
  expect(ackPendingBoundary(s, "S")).toBe(1);
  expect(s.get("R")?.notifyState).toBe("acked");
  expect(s.get("OTHER")?.notifyState).toBe("sent");
});
