import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { admitNewSpawn, admitRespawn, reservedSlots } from "../../src/jobs/capacity.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("reservedSlots 是派生值，等于 retryAt 非空的条数（F46）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  expect(reservedSlots(s)).toBe(10);
});

it("10 条链同时退避时每条 respawn 都被准入（F60 自锁）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  for (let i = 0; i < 10; i++) expect(admitRespawn(s, `c${i}`, 10)).toBe(true);
});

it("新 spawn 受 running + reserved 限制（F47）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  for (let i = 0; i < 10; i++) s.put(j(`c${i}`, { retryAt: 100 }));
  expect(admitNewSpawn(s, 10)).toBe(false);
  expect(admitNewSpawn(s, 11)).toBe(true);
});

it("purged 链的退避不占 reservedSlot（MAJOR #2）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-cap-")));
  s.put(j("R", { retryAt: 100, purged: true }));
  s.put(j("R2", { rootId: "R", retryAt: 100 }));
  expect(reservedSlots(s)).toBe(0);
  expect(admitNewSpawn(s, 10)).toBe(true);
});
