import { describe, expect, it } from "vitest";
import { DEFAULTS, resolveConfig } from "../../src/lib/config.js";

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
