import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { escalate, requestKill } from "../../src/jobs/kill.js";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";

const j = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 999_999,
  status: "failed", exitCode: 1, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: "R", attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("按 rootId 取消整链：清 retryAt 并记 requestedBy（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  const r = requestKill(s, "R", "self", 1000);
  expect(r.cancelledBackoff.sort()).toEqual(["R", "R2"]);
  expect(s.get("R")?.retryAt).toBeUndefined();
  expect(s.get("R")?.kill).toEqual({ requestedBy: "self", at: 1000 });
});

it("按链上任意 id 也能定位 root（F33）", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  s.put(j("R", { retryAt: 500 }));
  s.put(j("R2", { retryOf: "R", retryAt: 900 }));
  expect(requestKill(s, "R2", "external", 1000).cancelledBackoff).toHaveLength(2);
});

it("未知 id 返回空结果，不抛", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}")));
  expect(requestKill(s, "nope", "self", 1)).toEqual({ killed: [], cancelledBackoff: [] });
});

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(20);
  }
  return false;
};

it("F116 escalate：忽略 SIGTERM 的进程在超时后被 SIGKILL", async () => {
  const child = spawn("sh", ["-c", "trap '' TERM; while true; do sleep 1; done"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  try {
    await sleep(100);                     // 等 shell 安装 trap，避免开局默认处置
    const t0 = Date.now();
    await escalate(pid, 200);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(await gone(pid)).toBe(true);
  } finally {
    if (!(await gone(pid))) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }
});

it("F116 escalate：进程组优先，忽略 TERM 的子进程也被 SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "{{SECRET_9qv7roa4}}"));
  const script = join(dir, "s.sh");
  const out = join(dir, "grandchild.pid");
  writeFileSync(script, [
    "#!/bin/sh",
    "trap '' TERM",
    "sh -c 'trap \"\" TERM; while true; do sleep 1; done' &",
    "echo $! > \"$1\"",
    "wait",
    "",
  ].join("\n"));
  const child = spawn("sh", [script, out], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  let grandchild: number | undefined;
  try {
    for (let i = 0; i < 100 && grandchild === undefined; i++) {
      try {
        const raw = readFileSync(out, "utf8").trim();
        if (raw) grandchild = Number(raw);
      } catch { /* not yet */ }
      await sleep(20);
    }
    expect(grandchild).toBeDefined();
    await sleep(100);                     // 等子 shell 安装 trap
    await escalate(pid, 200);
    expect(await gone(pid)).toBe(true);
    expect(await gone(grandchild!)).toBe(true);
  } finally {
    for (const target of [pid, grandchild]) {
      if (target === undefined) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
      try { process.kill(target, "SIGKILL"); } catch { /* ignore */ }
    }
  }
});

it("F116 escalate：已退出进程不抛", async () => {
  const child = spawn("true", [], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((res) => child.once("exit", () => res()));
  await expect(escalate(pid, 100)).resolves.toBeUndefined();
});
