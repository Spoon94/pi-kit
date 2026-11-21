import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, DEFAULTS, resolveConfig } from "../../src/lib/config.js";

describe("resolveConfig", () => {
  it("空来源全部走默认值", () => {
    expect(resolveConfig({})).toEqual(DEFAULTS);
    expect(DEFAULTS.wipLimit).toBe(3);
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
