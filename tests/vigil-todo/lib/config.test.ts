import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, DEFAULTS, createConfigLoader, resolveConfig } from "../../../src/vigil-todo/lib/config.js";

describe("resolveConfig", () => {
  it("all defaults apply when sources are empty", () => {
    expect(resolveConfig({})).toEqual(DEFAULTS);
    expect(DEFAULTS.wipLimit).toBe(1);
    expect(DEFAULTS.retries).toBe(5);
    expect(DEFAULTS.retryDelaysMs).toEqual([0, 30_000, 120_000, 300_000, 600_000]);
    expect(DEFAULTS.maxTurns).toBe(50);
    expect(DEFAULTS.staleReverify).toBe(1);
    expect(DEFAULTS.maxConcurrentJobs).toBe(10);
  });

  it("default total attempts 6: retries=5, five backoff tiers (avoiding 4)", () => {
    expect(1 + DEFAULTS.retries).toBe(6);
    expect(DEFAULTS.retryDelaysMs).toHaveLength(5);
    expect(DEFAULTS.retryDelaysMs).toEqual([0, 30_000, 120_000, 300_000, 600_000]);
  });

  it("file > settings.vigilTodo > legacy.bgRun > defaults", () => {
    const c = resolveConfig({
      file: { wipLimit: 5 },
      settings: { wipLimit: 4, maxTurns: 9 },
      legacy: { maxConcurrentJobs: 2, maxTurns: 7 },
    });
    expect(c.wipLimit).toBe(5);
    expect(c.maxTurns).toBe(9);
    expect(c.maxConcurrentJobs).toBe(2);
  });

  it("invalid values fall back to defaults without throwing", () => {
    const c = resolveConfig({
      file: { wipLimit: 0, retries: -1, maxTurns: "50", tailLines: 1.5, collapseKey: "" },
    });
    expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
    expect(c.retries).toBe(DEFAULTS.retries);
    expect(c.maxTurns).toBe(DEFAULTS.maxTurns);
    expect(c.tailLines).toBe(DEFAULTS.tailLines);
    expect(c.collapseKey).toBe(DEFAULTS.collapseKey);
  });

  it("collapseKey / haltKey allow the off sentinel (C4)", () => {
    expect(resolveConfig({ file: { collapseKey: "off" } }).collapseKey).toBe("off");
    expect(resolveConfig({ file: { haltKey: "off" } }).haltKey).toBe("off");
    expect(resolveConfig({ file: { haltKey: " alt+H " } }).haltKey).toBe("alt+h");
    expect(resolveConfig({ file: { haltKey: "" } }).haltKey).toBe(DEFAULTS.haltKey);
  });
});

it("CONFIG_KEYS covers every VigilConfig key, with no missing or extra entries", () => {
  expect(Object.keys(CONFIG_KEYS).sort()).toEqual(Object.keys(DEFAULTS).sort());
});

it("each key's default matches DEFAULTS (docs cannot drift)", () => {
  for (const [k, meta] of Object.entries(CONFIG_KEYS)) {
    expect(meta.default).toEqual((DEFAULTS as unknown as Record<string, unknown>)[k]);
  }
});

it("only collapseKey / haltKey require reload", () => {
  const needReload = Object.entries(CONFIG_KEYS).filter(([, m]) => m.reload).map(([k]) => k);
  expect(needReload).toEqual(["collapseKey", "haltKey"]);
});

it("taskRetentionMs defaults to 0 (automatic task retention deletion off by default)", () => {
  expect(DEFAULTS.taskRetentionMs).toBe(0);
  expect(resolveConfig({}).taskRetentionMs).toBe(0);
});

it("valid int[] overrides take effect (not silently ignored)", () => {
  expect(resolveConfig({ file: { retryDelaysMs: [0, 1000] } }).retryDelaysMs).toEqual([0, 1000]);
});

it("an invalid value for one key affects only that key; other keys still apply", () => {
  const c = resolveConfig({ file: { wipLimit: -5, maxTurns: 7 } });
  expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
  expect(c.maxTurns).toBe(7);
});

it("loader separates stat from read: unchanged means no file read, only settings/mtime changes trigger a reread (BLOCKER)", () => {
  let reads = 0; let mtime = 1; let key = "a";
  const load = createConfigLoader({
    stat: () => ({ mtimeMs: mtime, settingsKey: key }),
    read: () => { reads++; return { file: { maxTurns: reads + 1 } }; },
  });
  const first = load();
  expect(reads).toBe(1);
  expect(load()).toBe(first);
  expect(reads).toBe(1);
  key = "b";
  expect(load().maxTurns).toBe(3);
  mtime = 2;
  expect(load().maxTurns).toBe(4);
});

it("values above the limit fall back per key to defaults (max enforced, MINOR #4)", () => {
  const c = resolveConfig({ file: {
    maxTailBytes: 1e12, maxTurns: 20_000, wipLimit: 1000, tailLines: 501,
    maxWidgetLines: 201, retryDelaysMs: [0, 4_000_000],
  } });
  expect(c.maxTailBytes).toBe(DEFAULTS.maxTailBytes);
  expect(c.maxTurns).toBe(DEFAULTS.maxTurns);
  expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
  expect(c.tailLines).toBe(DEFAULTS.tailLines);
  expect(c.maxWidgetLines).toBe(DEFAULTS.maxWidgetLines);
  expect(c.retryDelaysMs).toEqual(DEFAULTS.retryDelaysMs);
});

it("boundary values themselves are accepted", () => {
  const c = resolveConfig({ file: { wipLimit: 100, maxTailBytes: 1_048_576, tailLines: 500 } });
  expect(c.wipLimit).toBe(100);
  expect(c.maxTailBytes).toBe(1_048_576);
  expect(c.tailLines).toBe(500);
});

it("CONFIG_KEYS exposes the limits (MINOR #4)", () => {
  expect(CONFIG_KEYS.maxTailBytes.max).toBe(1_048_576);
  expect(CONFIG_KEYS.maxWidgetLines.max).toBe(200);
  expect(CONFIG_KEYS.wipLimit.max).toBe(100);
  expect(CONFIG_KEYS.maxConcurrentJobs.max).toBe(200);
  expect(CONFIG_KEYS.maxTurns.max).toBe(10_000);
  expect(CONFIG_KEYS.tailLines.max).toBe(500);
});

it("the max column in docs/vigil-todo/configuration.md matches CONFIG_KEYS exactly", () => {
  const doc = readFileSync(new URL("../../../docs/vigil-todo/configuration.md", import.meta.url), "utf8");
  for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
    const row = doc.split("\n").find((line) => line.startsWith(`| \`${key}\` |`));
    expect(row, key).toBeDefined();
    const maxCell = row!.split("|").map((s) => s.trim())[4];
    if (meta.max === undefined) expect(maxCell, key).toBe("—");
    else expect(maxCell, key).toContain(String(meta.max));
  }
});
