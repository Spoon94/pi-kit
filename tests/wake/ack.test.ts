import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import { ackByWakeId, clearRenudgeOnSettled, createAckTracker, markSent, resetOnUserInput } from "../../src/wake/ack.js";
import { WAKE_CUSTOM_TYPE } from "../../src/wake/compose.js";

const store = () => createJobStore(mkdtempSync(join(tmpdir(), "vigil-ack-")));
const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: "/tmp/a.log", cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  taskId: 1, sessionId: "S", evidenceApplied: true, finalized: true, notifyState: "pending", ...o,
});

it("markSent 只写 root 记录（F89）", () => {
  const s = store();
  s.put(j("R")); s.put(j("M", { rootId: "R" }));
  markSent(s, ["R"], "w1", 100);
  expect(s.get("R")).toMatchObject({ notifyState: "sent", wakeId: "w1", notifySentAt: 100 });
  expect(s.get("M")?.notifyState).toBe("pending");
});

it("message 路径按 wakeId 批量 ack（F55）", () => {
  const s = store();
  s.put(j("R")); s.put(j("R2"));
  markSent(s, ["R", "R2"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, WAKE_CUSTOM_TYPE, "w1")).toBe(2);
  expect(s.get("R")?.notifyState).toBe("acked");
  expect(s.get("R2")?.notifyState).toBe("acked");
});

it("不匹配的 customType / wakeId 不 ack", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  const t = createAckTracker();
  expect(t.onMessage(s, "other", "w1")).toBe(0);
  expect(t.onMessage(s, WAKE_CUSTOM_TYPE, "wX")).toBe(0);
});

it("boundary 路径靠紧随的 agent_start ack（F61）", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(t.onAgentStart(s, "S")).toBe(1);
  expect(s.get("R")?.notifyState).toBe("acked");
});

it("boundary entries 被丢弃 ⇒ 无 agent_start ⇒ 留 sent（F71）", () => {
  const s = store(); s.put(j("R"));
  markSent(s, ["R"], "wB", 100);
  const t = createAckTracker();
  t.expectBoundary("wB", ["R"]);
  expect(s.get("R")?.notifyState).toBe("sent");
});

it("acked 幂等，重复 ack 不重复计数", () => {
  const s = store(); s.put(j("R")); markSent(s, ["R"], "w1", 100);
  expect(ackByWakeId(s, "w1")).toBe(1);
  expect(ackByWakeId(s, "w1")).toBe(0);
});

it("用户 input 归零 turnsUsed（F65）", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 49, wakeWatermark: 500, renudgeBudget: 1 };
  expect(resetOnUserInput(b.counters)).toEqual({ turnsUsed: 0, wakeWatermark: 500, renudgeBudget: 1 });
});

it("agent_settled 清零 renudgeBudget（F70）", () => {
  const b = emptyBoard();
  b.counters = { turnsUsed: 3, wakeWatermark: 500, renudgeBudget: 1 };
  expect(clearRenudgeOnSettled(b.counters).renudgeBudget).toBe(0);
});
