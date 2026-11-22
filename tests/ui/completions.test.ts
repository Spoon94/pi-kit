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

it("T1 panel subcommands: empty prefix returns all, h/r/d prefixes filter, unknown returns null", () => {
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

it("F131 completions: top level includes clear; clear prefix offers only three scope candidates (no all)", () => {
  expect(panelCompletions("")!.map((c) => c.value)).toContain("clear");
  expect(panelCompletions("clear ")!.map((c) => c.value))
    .toEqual(["clear completed", "clear deleted", "clear settled"]);
  expect(panelCompletions("clear ")!.map((c) => c.value)).not.toContain("clear all");
  expect(panelCompletions("clear c")!.map((c) => c.value)).toEqual(["clear completed"]);
  expect(panelCompletions("clear d")!.map((c) => c.value)).toEqual(["clear deleted"]);
  expect(panelCompletions("clear s")!.map((c) => c.value)).toEqual(["clear settled"]);
  expect(panelCompletions("clear a")).toBeNull();
  expect(panelCompletions("clear z")).toBeNull();
  expect(panelCompletions("clear ")![0].description).toContain("Clear only completed tasks");
  expect(panelCompletions("clear ")![2].description).toContain("default scope");
});

it("T2 /bg subcommands and dynamic ids: k lists only running/backoff, tail lists all", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-comp-"));
  const s = createJobStore(dir);
  expect(bgCompletions("")!.map((c) => c.value)).toEqual(["k", "tail"]);
  expect(bgCompletions("k")!.map((c) => c.value)).toEqual(["k"]);
  expect(bgCompletions("t")!.map((c) => c.value)).toEqual(["tail"]);
  expect(bgCompletions("x")).toBeNull();
  expect(bgCompletions("k ", s)).toBeNull();            // no jobs → null, not an empty array
  expect(bgCompletions("tail ", s)).toBeNull();

  s.put(job("bg_run", { label: "training", status: "running", endedAt: null, exitCode: null }));
  s.put(job("bg_back", { label: "backoff", status: "failed", retryAt: 500 }));
  s.put(job("bg_done", { label: "done" }));
  const k = bgCompletions("k ", s)!;
  expect(k.map((c) => c.label)).toEqual(["bg_run", "bg_back"]);
  expect(k.map((c) => c.value)).toEqual(["k bg_run", "k bg_back"]);
  expect(k[0].description).toContain("training");
  expect(k[0].description).toContain("running");
  expect(k[1].description).toContain("backoff");

  const tail = bgCompletions("tail ", s)!;
  expect(tail.map((c) => c.label)).toEqual(["bg_run", "bg_back", "bg_done"]);
  expect(tail[2].value).toBe("tail bg_done");
  expect(tail[2].description).toContain("exit 0");
  expect(bgCompletions("k bg_b", s)!.map((c) => c.label)).toEqual(["bg_back"]);
  expect(BG_SUBCOMMANDS.map((c) => c.value)).toEqual(["k", "tail"]);
});

it("T2 candidates truncate to the cap of 50", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-comp-")));
  for (let i = 0; i < 60; i++) s.put(job(`bg_${String(i).padStart(2, "0")}`, { status: "running" }));
  expect(bgCompletions("k ", s)).toHaveLength(COMPLETION_JOB_LIMIT);
  expect(bgCompletions("tail ", s)).toHaveLength(COMPLETION_JOB_LIMIT);
});

it("completion is pure read and never throws: no save, no store mutation, broken store returns null", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-comp-"));
  const s = createJobStore(dir);
  s.put(job("bg_x", { status: "running" }));
  s.put(job("bg bad id", { label: "space" }));          // malformed ids that would split arguments are excluded from candidates
  expect(bgCompletions("tail ", s)!.map((c) => c.label)).not.toContain("bg bad id");
  const before = JSON.stringify(s.all());
  s.put = () => { throw new Error("mutated"); };
  s.save = () => { throw new Error("saved"); };
  expect(() => bgCompletions("k ", s)).not.toThrow();
  expect(() => bgCompletions("tail ", s)).not.toThrow();
  expect(JSON.stringify(s.all())).toBe(before);
  expect(existsSync(join(dir, "jobs.json"))).toBe(false);

  expect(bgCompletions("k ", undefined)).toBeNull();
  expect(bgCompletions("tail ", undefined)).toBeNull();
  const broken = { all: () => { throw new Error("boom"); } } as never;
  expect(bgCompletions("k ", broken)).toBeNull();
  expect(bgCompletions(undefined as never, s)).not.toBeNull();
  expect(bgCompletions(undefined as never, undefined)!.map((c) => c.value)).toEqual(["k", "tail"]);
});

it("malicious job.label is sanitized in description", () => {
  const s = createJobStore(mkdtempSync(join(tmpdir(), "vigil-comp-")));
  s.put(job("bg_evil", { label: "\u001b]0;pwned\u0007\u001b[31mRED" }));
  const c = bgCompletions("tail ", s)![0];
  expect(c.description).not.toContain("\u001b");
  expect(c.description).not.toContain("\u0007");
  expect(c.description).toContain("RED");
});

it("T3 /todos has no candidates", () => {
  expect(todosCompletions()).toBeNull();
  expect(todosCompletions("anything")).toBeNull();
});