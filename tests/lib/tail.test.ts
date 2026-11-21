import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tailLines } from "../../src/lib/tail.js";

it("只取末 N 行", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "a.log");
  writeFileSync(p, Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n"));
  expect(tailLines(p, 3, 8192)).toEqual(["line997", "line998", "line999"]);
});

it("大文件不整读：maxBytes 限制生效（Review Focus 4）", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "big.log");
  writeFileSync(p, "x".repeat(200_000) + "\nlast");
  const out = tailLines(p, 5, 64);
  expect(out.join("").length).toBeLessThanOrEqual(64);
  expect(out.at(-1)).toContain("last");
});

it("文件不存在返回空数组，不抛（Review Focus 4）", () => {
  expect(tailLines("/nonexistent/vigil.log", 20, 8192)).toEqual([]);
});
