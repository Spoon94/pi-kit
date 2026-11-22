import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createJobStore } from "../../src/jobs/store.js";
import type { Job } from "../../src/jobs/types.js";
import {
  BG_SUBCOMMANDS, COMPLETION_JOB_LIMIT, PANEL_SUBCOMMANDS,
  bgCompletions, panelCompletions, todosCompletions,
} from "../../src/ui/completions.js";

const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, label: id, command: "true", logPath: `/tmp/${id}.log`, cwd: "/tmp", pid: 1,
  status: "completed", exitCode: 0, exitCodeKnown: true, startedAt: 1, endedAt: 2,
  fpVerdict: "fresh", interferers: [], rootId: id, attempt: 1,
  evidenceApplied: false, notifyState: "pending", ...o,
});

it("T1 面板子命令：空前缀全出，h/r/d 前缀过滤，未知返回 null", () => {
  expect(panelCompletions("")!.map((c) => c.value)).toEqual(["halt", "resume", "doctor", "clear"]);
  expect(panelCompletions("h")!.map((c) => c.value)).toEqual(["halt"]);
  expect(panelCompletions("r")!.map((c) => c.value)).toEqual(["resume"]);
  expect(panelCompletions("d")!.map((c) => c.value)).toEqual(["doctor"]);
  expect(panelCompletions("c")!.map((c) => c.value)).toEqual(["clear"]);
  expect(panelCompletions("H")!.map((c) => c.value)).toEqual(["halt"]);
  expect(panelCompletions("x")).toBeNull();
  expect(panelCompletions(undefined as never)!.map((c) => c.value))
    .toEqual(PANEL_SUBCOMMANDS.map((c) => c.value));
  expect(PANEL_SUBCOMMANDS.find((c) => c.value === "halt")?.description).toContain("park");
});

it("F131 补全：一级含 clear，clear 前缀出四个范围候选", () => {
  expect(panelCompletions("")!.map((c) => c.value)).toContain("clear");
  expect(panelCompletions("clear ")!.map((c) => c.value))
    .toEqual(["clear completed", "clear deleted", "clear settled", "clear all"]);
  expect(panelCompletions("clear c")!.map((c) => c.value)).toEqual(["clear completed"]);
  expect(panelCompletions("clear d")!.map((c) => c.value)).toEqual(["clear deleted"]);
  expect(panelCompletions("clear s")!.map((c) => c.value)).toEqual(["clear settled"]);
  expect(panelCompletions("clear a")!.map((c) => c.value)).toEqual(["clear all"]);
  expect(panelCompletions("clear z")).toBeNull();
  expect(panelCompletions("clear ")![0].description).toContain("已完成");
  expect(panelCompletions("clear ")![3].description).toContain("confirm");
});

it("T2 /bg 子命令与动态 id：k 只列 running/退避，tail 列全部", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-comp-"));
  const s = createJobStore(dir);
  expect(bgCompletions("")!.map((c) => c.value)).toEqual(["k", "tail"]);
  expect(bgCompletions("k")!.map((c) => c.value)).toEqual(["k"]);
  expect(bgCompletions("t")!.map((c) => c.value)).toEqual(["tail"]);
  expect(bgCompletions("x")).toBeNull();
  expect(bgCompletions("k ", s)).toBeNull();            // 无作业 → null，不是空数组
  expect(bgCompletions("tail ", s)).toBeNull();

  s.put(job("bg_run", { label: "训练", status: "running", endedAt: null, exitCode: null }));
  s.put(job("bg_back", { label: "退避", status: "failed", retryAt: 500 }));
  s.put(job("bg_done", { label: "完成" }));
  const k = bgCompletions("k ", s)!;
  expect(k.map((c) => c.label)).toEqual(["bg_run", "bg_back"]);
  expect(k.map((c) => c.value)).toEqual(["k bg_run", "k bg_back"]);
  expect(k[0].description).toContain("训练");
  expect(k[0].description).toContain("running");
  expect(k[1].description).toContain("backoff");

  const tail = bgCompletions("tail ", s)!;
  expect(tail.map((c) => c.label)).toEqual(["bg_run", "bg_back", "bg_done"]);
  expect(tail[2].value).toBe("tail bg_done");
  expect(tail[2].description).toContain("exit 0");
  expect(bgCompletions("k bg_b", s)!.map((c) => c.label)).toEqual(["bg_back"]);
  expect(BG_SUBCOMMANDS.map((c) => c.value)).toEqual(["k", "tail"]);
});

it("T2 候选上限截断到 50", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-comp-")));
  for (let i = 0; i < 60; i++) s.put(job(`bg_${String(i).padStart(2, "0")}`, { status: "running" }));
  expect(bgCompletions("k ", s)).toHaveLength(COMPLETION_JOB_LIMIT);
  expect(bgCompletions("tail ", s)).toHaveLength(COMPLETION_JOB_LIMIT);
});

it("补全纯读、永不抛：不 save、不改 store、坏 store 返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-comp-"));
  const s = createJobStore(dir);
  s.put(job("bg_x", { status: "running" }));
  s.put(job("bg bad id", { label: "space" }));          // 会拆参数的畸形 id 不进入候选
  expect(bgCompletions("tail ", s)!.map((c) => c.label)).not.toContain("bg bad id");
  const before = JSON.stringify(s.all());
  s.put = () => { throw new Error("mutated"); };
  s.save = () => { throw new Error("saved"); };
  expect(() => bgCompletions("k ", s)).not.toThrow();
  expect(() => bgCompletions("tail ", s)).not.toThrow();
  expect(JSON.stringify(s.all())).toBe(before);
  expect(existsSync(join(dir, "jobs.json"))).toBe(false);

  expect(bgCompletions("k ", undefined)).toBeNull();
  const broken = { all: () => { throw new Error("boom"); } } as never;
  expect(bgCompletions("k ", broken)).toBeNull();
  expect(bgCompletions(undefined as never, s)).not.toBeNull();
  expect(bgCompletions(undefined as never, undefined)!.map((c) => c.value)).toEqual(["k", "tail"]);
});

it("恶意 job.label 进 description 后被清洗", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-comp-")));
  s.put(job("bg_evil", { label: "\u001b]0;pwned\u0007\u001b[31mRED" }));
  const c = bgCompletions("tail ", s)![0];
  expect(c.description).not.toContain("\u001b");
  expect(c.description).not.toContain("\u0007");
  expect(c.description).toContain("RED");
});

it("T3 /todos 无候选", () => {
  expect(todosCompletions()).toBeNull();
  expect(todosCompletions("anything")).toBeNull();
});