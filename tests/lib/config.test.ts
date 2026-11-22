import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, DEFAULTS, createConfigLoader, resolveConfig } from "../../src/lib/config.js";

describe("resolveConfig", () => {
  it("空来源全部走默认值", () => {
    expect(resolveConfig({})).toEqual(DEFAULTS);
    expect(DEFAULTS.wipLimit).toBe(1);
    expect(DEFAULTS.retries).toBe(3);
    expect(DEFAULTS.retryDelaysMs).toEqual([0, 30_000, 120_000]);
    expect(DEFAULTS.maxTurns).toBe(50);
    expect(DEFAULTS.staleReverify).toBe(1);
    expect(DEFAULTS.maxConcurrentJobs).toBe(10);
  });

  it("file > settings.vigilTodo > legacy.bgRun > 默认", () => {
    const c = resolveConfig({
      file: { wipLimit: 5 },
      settings: { wipLimit: 4, maxTurns: 9 },
      legacy: { maxConcurrentJobs: 2, maxTurns: 7 },
    });
    expect(c.wipLimit).toBe(5);
    expect(c.maxTurns).toBe(9);
    expect(c.maxConcurrentJobs).toBe(2);
  });

  it("非法值退回默认，不抛异常", () => {
    const c = resolveConfig({
      file: { wipLimit: 0, retries: -1, maxTurns: "50", tailLines: 1.5, collapseKey: "" },
    });
    expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
    expect(c.retries).toBe(DEFAULTS.retries);
    expect(c.maxTurns).toBe(DEFAULTS.maxTurns);
    expect(c.tailLines).toBe(DEFAULTS.tailLines);
    expect(c.collapseKey).toBe(DEFAULTS.collapseKey);
  });

  it("collapseKey 允许 off 哨兵", () => {
    expect(resolveConfig({ file: { collapseKey: "off" } }).collapseKey).toBe("off");
  });
});

it("CONFIG_KEYS 覆盖 VigilConfig 全部键，无遗漏无多余", () => {
  expect(Object.keys(CONFIG_KEYS).sort()).toEqual(Object.keys(DEFAULTS).sort());
});

it("每个键的 default 与 DEFAULTS 一致（文档不会漂移）", () => {
  for (const [k, meta] of Object.entries(CONFIG_KEYS)) {
    expect(meta.default).toEqual((DEFAULTS as unknown as Record<string, unknown>)[k]);
  }
});

it("只有 collapseKey 需要 reload", () => {
  const needReload = Object.entries(CONFIG_KEYS).filter(([, m]) => m.reload).map(([k]) => k);
  expect(needReload).toEqual(["collapseKey"]);
});

it("taskRetentionMs 默认 0（自动删任务默认关闭）", () => {
  expect(DEFAULTS.taskRetentionMs).toBe(0);
  expect(resolveConfig({}).taskRetentionMs).toBe(0);
});

it("逐键非法值只影响该键，其他键仍生效", () => {
  const c = resolveConfig({ file: { wipLimit: -5, maxTurns: 7 } });
  expect(c.wipLimit).toBe(DEFAULTS.wipLimit);
  expect(c.maxTurns).toBe(7);
});

it("loader 分离 stat 与读取：未变不读文件，settings/mtime 变化才重读（BLOCKER）", () => {
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

it("超上限逐项退回默认（max 生效，MINOR #4）", () => {
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

it("边界值本身可用", () => {
  const c = resolveConfig({ file: { wipLimit: 100, maxTailBytes: 1_048_576, tailLines: 500 } });
  expect(c.wipLimit).toBe(100);
  expect(c.maxTailBytes).toBe(1_048_576);
  expect(c.tailLines).toBe(500);
});

it("CONFIG_KEYS 暴露上限（MINOR #4）", () => {
  expect(CONFIG_KEYS.maxTailBytes.max).toBe(1_048_576);
  expect(CONFIG_KEYS.maxWidgetLines.max).toBe(200);
  expect(CONFIG_KEYS.wipLimit.max).toBe(100);
  expect(CONFIG_KEYS.maxConcurrentJobs.max).toBe(200);
  expect(CONFIG_KEYS.maxTurns.max).toBe(10_000);
  expect(CONFIG_KEYS.tailLines.max).toBe(500);
});

it("docs/configuration.md 的 max 列与 CONFIG_KEYS 完全一致", () => {
  const doc = readFileSync(new URL("../../docs/configuration.md", import.meta.url), "utf8");
  for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
    const row = doc.split("\n").find((line) => line.startsWith(`| \`${key}\` |`));
    expect(row, key).toBeDefined();
    const maxCell = row!.split("|").map((s) => s.trim())[4];
    if (meta.max === undefined) expect(maxCell, key).toBe("—");
    else expect(maxCell, key).toContain(String(meta.max));
  }
});
