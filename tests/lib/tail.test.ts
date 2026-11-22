import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tailLines } from "../../src/lib/tail.js";

it("returns only the last N lines", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "a.log");
  writeFileSync(p, Array.from({ length: 1000 }, (_, i) => `line${i}`).join("\n"));
  expect(tailLines(p, 3, 8192)).toEqual(["line997", "line998", "line999"]);
});

it("large files are not read whole: the maxBytes limit applies (Review Focus 4)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "vigil-tail-")), "big.log");
  writeFileSync(p, "x".repeat(200_000) + "\nlast");
  const out = tailLines(p, 5, 64);
  expect(out.join("").length).toBeLessThanOrEqual(64);
  expect(out.at(-1)).toContain("last");
});

it("a missing file returns an empty array instead of throwing (Review Focus 4)", () => {
  expect(tailLines("/nonexistent/vigil.log", 20, 8192)).toEqual([]);
});

it("trailing newline and empty file edge cases", () => {
  const d = mkdtempSync(join(tmpdir(), "vigil-tail-"));
  const p = join(d, "trailing.log");
  writeFileSync(p, "a\nb\n");
  expect(tailLines(p, 5, 8192)).toEqual(["a", "b"]);
  const empty = join(d, "empty.log");
  writeFileSync(empty, "");
  expect(tailLines(empty, 5, 8192)).toEqual([]);
});
