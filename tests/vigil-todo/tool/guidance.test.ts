import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";
import type { RuleContext } from "../../../src/vigil-todo/board/invariants.js";
import { createJobStore } from "../../../src/vigil-todo/jobs/store.js";
import { DEFAULTS } from "../../../src/vigil-todo/lib/config.js";
import {
  createBgKillTool, createBgListTool, createBgRunTool, createTodoTool, type ToolDeps,
} from "../../../src/vigil-todo/tool/register.js";
import { createGuidanceLoader, DEFAULT_GUIDANCE, resolveGuidance } from "../../../src/vigil-todo/tool/guidance.js";
import { BgKillParamsSchema, BgRunParamsSchema, TodoParamsSchema } from "../../../src/vigil-todo/tool/schema.js";

const ctx = (): RuleContext => ({
  wipLimit: 1, now: 1,
  facts: { hasRunning: () => false, hasBackoff: () => false, startedAt: () => undefined, exists: () => true },
});
const deps = (): ToolDeps => ({
  sessionId: () => "S", cwd: () => "/tmp", board: () => emptyBoard(), commit: () => {}, appendEntry: () => {},
  ruleCtx: ctx, jobs: createJobStore(mkdtempSync(join(tmpdir(), "vigil-guide-"))), cfg: DEFAULTS,
  spawn: () => ({ ok: true }), kill: () => {}, runVerify: async () => ({ ok: true, exitCode: 0 }), now: () => 1,
});
const defs = (guidance = DEFAULT_GUIDANCE) => [
  createTodoTool(deps(), guidance), createBgRunTool(deps(), guidance),
  createBgListTool(deps(), guidance), createBgKillTool(deps(), guidance),
];

it("F120: all four tools have promptSnippet/promptGuidelines covering six key points together", () => {
  const list = defs();
  for (const d of list) {
    expect(d.promptSnippet?.trim()).toBeTruthy();
    expect(d.promptGuidelines?.length).toBeGreaterThan(0);
    expect(d.description.length).toBeGreaterThan(80);
  }
  const text = list.flatMap((d) => [d.promptSnippet ?? "", ...(d.promptGuidelines ?? [])]).join("\n");
  for (const needle of [
    "bg_run", "bash", "WIP=1", "park", "reason", "evidence", 'accept:"stale"',
    'scope:"all"', "force", "next", "wake",
    "sleep", "overnight", "background", "/vt halt",
  ]) expect(text, needle).toContain(needle);
  expect(DEFAULT_GUIDANCE.promptGuidelines.length).toBeGreaterThanOrEqual(6);
});

it("F122: the four per-tool snippets differ; per-tool override and global fallback are supported", () => {
  const list = defs();
  expect(new Set(list.map((d) => d.promptSnippet)).size).toBe(4);
  for (const s of Object.values(DEFAULT_GUIDANCE.snippets)) expect(s.trim()).not.toBe("");

  const per = resolveGuidance({ file: { guidance: { snippets: { todo: "T", bg_run: "R" } } } });
  expect(per.snippets.todo).toBe("T");
  expect(per.snippets.bg_run).toBe("R");
  expect(per.snippets.bg_list).toBe(DEFAULT_GUIDANCE.snippets.bg_list);
  expect(per.snippets.bg_kill).toBe(DEFAULT_GUIDANCE.snippets.bg_kill);

  const global = resolveGuidance({ file: { guidance: { promptSnippet: "G" } } });
  expect(Object.values(global.snippets)).toEqual(["G", "G", "G", "G"]);
  expect(global.promptSnippet).toBe("G");
});

it("Every schema parameter has a non-empty description (including nested objects)", () => {
  const check = (schema: any, where: string): void => {
    for (const [key, prop] of Object.entries<any>(schema.properties ?? {})) {
      expect(typeof prop.description, `${where}.${key}`).toBe("string");
      expect(prop.description.length, `${where}.${key}`).toBeGreaterThan(0);
      if (prop.type === "object" && prop.properties) check(prop, `${where}.${key}`);
      if (prop.type === "array" && prop.items?.properties) check(prop.items, `${where}.${key}[]`);
    }
  };
  check(TodoParamsSchema, "todo");
  check(BgRunParamsSchema, "bg_run");
  check(BgKillParamsSchema, "bg_kill");
  const reasonDesc = (TodoParamsSchema.properties.reason as any).description as string;
  expect(reasonDesc).toContain("park");
  expect(reasonDesc).not.toContain("cleanup");
});

it("Guidance can be overridden by config; priority file > settings > legacy > default", () => {
  expect(resolveGuidance({})).toEqual(DEFAULT_GUIDANCE);
  const custom = { promptSnippet: "CUSTOM SNIPPET", promptGuidelines: ["CUSTOM LINE"] };
  const file = resolveGuidance({ file: { guidance: custom } });
  expect(file.promptSnippet).toBe("CUSTOM SNIPPET");
  expect(file.promptGuidelines).toEqual(["CUSTOM LINE"]);
  expect(Object.values(file.snippets)).toEqual(["CUSTOM SNIPPET", "CUSTOM SNIPPET", "CUSTOM SNIPPET", "CUSTOM SNIPPET"]);

  const layered = resolveGuidance({
    legacy: { guidance: { promptSnippet: "legacy", promptGuidelines: ["legacy"] } },
    settings: { guidance: { promptSnippet: "settings", promptGuidelines: ["settings"] } },
    file: { guidance: { promptSnippet: "file" } },
  });
  expect(layered.promptSnippet).toBe("file");
  expect(layered.promptGuidelines).toEqual(["settings"]);
  expect(Object.values(layered.snippets)).toEqual(["file", "file", "file", "file"]);
  expect(resolveGuidance({ file: { guidance: { promptSnippet: "", promptGuidelines: [""] } } })).toEqual(DEFAULT_GUIDANCE);
  const d = createTodoTool(deps(), file);
  expect(d.promptSnippet).toBe("CUSTOM SNIPPET");
  expect(d.promptGuidelines).toEqual(["CUSTOM LINE"]);
});

it("guidance loader cache: unchanged stat skips reread, change triggers reread", () => {
  let reads = 0; let key = "a";
  const load = createGuidanceLoader({
    stat: () => ({ mtimeMs: 1, settingsKey: key }),
    read: () => { reads++; return { file: { guidance: { promptSnippet: `s${reads}`, promptGuidelines: ["g"] } } }; },
  });
  const first = load();
  expect(reads).toBe(1);
  expect(load()).toBe(first);
  expect(reads).toBe(1);
  key = "b";
  expect(load().promptSnippet).toBe("s2");
});
