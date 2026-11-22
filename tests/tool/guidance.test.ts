import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyBoard } from "../../src/board/types.js";
import type { RuleContext } from "../../src/board/invariants.js";
import { createJobStore } from "../../src/jobs/store.js";
import { DEFAULTS } from "../../src/lib/config.js";
import {
  createBgKillTool, createBgListTool, createBgRunTool, createTodoTool, type ToolDeps,
} from "../../src/tool/register.js";
import { createGuidanceLoader, DEFAULT_GUIDANCE, resolveGuidance } from "../../src/tool/guidance.js";
import { BgKillParamsSchema, BgRunParamsSchema, TodoParamsSchema } from "../../src/tool/schema.js";

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

it("F120：四个工具都有 promptSnippet/promptGuidelines，合起来覆盖六条要点", () => {
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
  ]) expect(text, needle).toContain(needle);
  expect(DEFAULT_GUIDANCE.promptGuidelines.length).toBeGreaterThanOrEqual(6);
});

it("schema 每个参数都有非空 description（含嵌套对象）", () => {
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
});

it("指引可被配置覆盖，优先级 file > settings > legacy > 默认", () => {
  expect(resolveGuidance({})).toEqual(DEFAULT_GUIDANCE);
  const custom = { promptSnippet: "CUSTOM SNIPPET", promptGuidelines: ["CUSTOM LINE"] };
  expect(resolveGuidance({ file: { guidance: custom } })).toEqual(custom);
  expect(resolveGuidance({
    legacy: { guidance: { promptSnippet: "legacy", promptGuidelines: ["legacy"] } },
    settings: { guidance: { promptSnippet: "settings", promptGuidelines: ["settings"] } },
    file: { guidance: { promptSnippet: "file" } },
  })).toEqual({ promptSnippet: "file", promptGuidelines: ["settings"] });
  expect(resolveGuidance({ file: { guidance: { promptSnippet: "", promptGuidelines: [""] } } })).toEqual(DEFAULT_GUIDANCE);
  const d = createTodoTool(deps(), custom);
  expect(d.promptSnippet).toBe("CUSTOM SNIPPET");
  expect(d.promptGuidelines).toEqual(["CUSTOM LINE"]);
});

it("guidance loader 缓存：stat 未变不重读，变化才重读", () => {
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
