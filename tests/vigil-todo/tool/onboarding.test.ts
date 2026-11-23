import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { emptyBoard, type Task } from "../../../src/vigil-todo/board/types.js";
import { DEFAULTS, resolveConfig } from "../../../src/vigil-todo/lib/config.js";
import { DEFAULT_GUIDANCE, resolveGuidance } from "../../../src/vigil-todo/tool/guidance.js";
import {
  ONBOARDING_MAX, boardSignature, buildBoardSummary, buildOnboardingPrompt, createOnboardingCache,
} from "../../../src/vigil-todo/tool/onboarding.js";

const boardOf = (tasks: Partial<Task>[]): ReturnType<typeof emptyBoard> => ({
  ...emptyBoard(), tasks: tasks as Task[], nextId: 99,
});

it("F137 empty board gets the base onboarding sentence only", () => {
  const text = buildOnboardingPrompt(emptyBoard(), DEFAULT_GUIDANCE, "live");
  expect(text).toContain("todo create");
  expect(text).toContain("bg_run");
  expect(text).not.toContain("Current board");
  expect(text.length).toBeLessThanOrEqual(ONBOARDING_MAX);
});

it("F138 live mode appends the current WIP and the next actionable task", () => {
  const board = boardOf([
    { id: 1, subject: "wire onboarding", status: "in_progress" },
    { id: 2, subject: "write tests", status: "pending" },
    { id: 3, subject: "done thing", status: "completed" },
  ]);
  const text = buildOnboardingPrompt(board, DEFAULT_GUIDANCE, "live");
  expect(text).toContain("Current board: WIP #1 wire onboarding; next #2 write tests.");
  expect(buildBoardSummary(board)).toContain("next #2 write tests");
  expect(text.length).toBeLessThanOrEqual(ONBOARDING_MAX);
});

it("F140 off injects nothing, once drops the board digest", () => {
  const board = boardOf([{ id: 1, subject: "wip", status: "in_progress" }]);
  expect(buildOnboardingPrompt(board, DEFAULT_GUIDANCE, "off")).toBe("");
  const once = buildOnboardingPrompt(board, DEFAULT_GUIDANCE, "once");
  expect(once).toContain("todo create");
  expect(once).not.toContain("Current board");
});

it("F139 an unchanged board keeps a byte-identical prompt; a change updates it", () => {
  const build = createOnboardingCache();
  const board = boardOf([{ id: 1, subject: "a", status: "in_progress" }]);
  const first = build(board, DEFAULT_GUIDANCE, "live");
  const again = build(board, DEFAULT_GUIDANCE, "live");
  expect(again).toBe(first);
  expect(buildOnboardingPrompt(board, DEFAULT_GUIDANCE, "live")).toBe(first);

  const next = boardOf([{ id: 1, subject: "a", status: "in_progress" }, { id: 2, subject: "b", status: "pending" }]);
  expect(boardSignature(next)).not.toBe(boardSignature(board));
  expect(build(next, DEFAULT_GUIDANCE, "live")).not.toBe(first);
});

it("F141 a 5000-char subject still yields a prompt within the 1200-char cap", () => {
  const board = boardOf([
    { id: 1, subject: "X".repeat(5000), status: "in_progress" },
    { id: 2, subject: "Y".repeat(5000), status: "pending" },
  ]);
  const text = buildOnboardingPrompt(board, DEFAULT_GUIDANCE, "live");
  expect(text.length).toBeLessThanOrEqual(ONBOARDING_MAX);
  expect(text).toContain("#1");
});

it("F142 the builder is pure: no fs/child_process/time imports inside onboarding.ts", () => {
  const src = readFileSync(new URL("../../../src/vigil-todo/tool/onboarding.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/node:fs|node:child_process|readFileSync|writeFileSync|execFileSync/);
  expect(src).not.toMatch(/setTimeout|setInterval|setImmediate/);
});

it("F143 the onboarding guideline leads the defaults and follows user overrides", () => {
  expect(DEFAULT_GUIDANCE.promptGuidelines[0]).toContain("start of a new instruction");
  expect(DEFAULT_GUIDANCE.promptGuidelines[0]).toContain("todo create");
  const custom = resolveGuidance({ file: { guidance: { promptGuidelines: ["CUSTOM ONE"] } } });
  expect(custom.promptGuidelines).toEqual(["CUSTOM ONE"]);
  expect(custom.promptGuidelines[0]).not.toContain("start of a new instruction");
});

it("F140 onboardingPrompt defaults to live and accepts only the three modes", () => {
  expect(DEFAULTS.onboardingPrompt).toBe("live");
  expect(resolveConfig({}).onboardingPrompt).toBe("live");
  expect(resolveConfig({ file: { onboardingPrompt: "once" } }).onboardingPrompt).toBe("once");
  expect(resolveConfig({ file: { onboardingPrompt: " OFF " } }).onboardingPrompt).toBe("off");
  expect(resolveConfig({ file: { onboardingPrompt: "bogus" } }).onboardingPrompt).toBe("live");
});

it("F120 a configured onboardingPromptText replaces the base sentence", () => {
  const guidance = resolveGuidance({ file: { guidance: { onboardingPromptText: "CUSTOM ONBOARDING" } } });
  expect(buildOnboardingPrompt(emptyBoard(), guidance, "live")).toBe("CUSTOM ONBOARDING");
});

it("F138 a blank board digest and long subjects degrade gracefully", () => {
  const idle = boardOf([{ id: 1, subject: "done", status: "completed" }]);
  expect(buildBoardSummary(idle)).toBe("Current board: WIP none; next none.");

  const long = boardOf([{ id: 7, subject: "S".repeat(200), status: "in_progress" }]);
  const summary = buildBoardSummary(long);
  expect(summary).toContain("#7 S");
  expect(summary).toContain("…");
  expect(summary.length).toBeLessThan(140);
});

it("F141 an oversized custom base sentence is capped, and blank overrides fall back", () => {
  const huge = { ...DEFAULT_GUIDANCE, onboardingPromptText: "B".repeat(3000) };
  const text = buildOnboardingPrompt(emptyBoard(), huge, "live");
  expect(text.length).toBe(ONBOARDING_MAX);
  expect(text.endsWith("…")).toBe(true);

  const blank = { ...DEFAULT_GUIDANCE, onboardingPromptText: "   " };
  expect(buildOnboardingPrompt(emptyBoard(), blank, "live")).toContain("todo create");
});

it("F140 non-string or unknown onboardingPrompt values fall back to live", () => {
  for (const bad of [123, null, "sometimes", true] as unknown[]) {
    expect(resolveConfig({ file: { onboardingPrompt: bad } }).onboardingPrompt).toBe("live");
  }
});

it("F138 legacy tasks without a subject do not break the digest or the signature", () => {
  const legacy = { ...emptyBoard(), tasks: [
    { id: 4, status: "in_progress" } as unknown as Task,
    { id: 5, status: "pending" } as unknown as Task,
  ], nextId: 6 };
  expect(buildBoardSummary(legacy)).toContain("#4 ");
  expect(boardSignature(legacy)).toContain("4:");
  expect(buildOnboardingPrompt(legacy, DEFAULT_GUIDANCE, "live")).toContain("Current board");
});
