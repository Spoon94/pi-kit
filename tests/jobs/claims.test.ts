import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claim, release, takeoverStale } from "../../src/jobs/claims.js";

const dir = () => mkdtempSync(join(tmpdir(), "{{SECRET_vg57m6zb}}"));

it("O_EXCL：同一 claim 只有一个赢家（F101）", () => {
  const d = dir();
  expect(claim(d, "R", "adopt", "A", 1)).toBe(true);
  expect(claim(d, "R", "adopt", "B", 1)).toBe(false);
});

it("adopt 与 respawn 互不覆盖", () => {
  const d = dir();
  expect(claim(d, "R", "adopt", "A", 1)).toBe(true);
  expect(claim(d, "R", "respawn", "A", 1)).toBe(true);
});

it("release 后可再认领", () => {
  const d = dir();
  claim(d, "R", "adopt", "A", 1);
  release(d, "R", "adopt");
  expect(claim(d, "R", "adopt", "B", 2)).toBe(true);
});

it("过期收回用 rename 竞争，只有一个获重建权（F103）", () => {
  const d = dir();
  claim(d, "R", "adopt", "A", 1);
  const a = takeoverStale(d, "R", "adopt", "A", () => true);
  const b = takeoverStale(d, "R", "adopt", "B", () => true);
  expect([a, b].filter(Boolean)).toHaveLength(1);
});

it("claim 不存在时 takeover 返回 false，不抛（Review Focus 4）", () => {
  expect(takeoverStale(dir(), "R", "adopt", "A", () => true)).toBe(false);
});
