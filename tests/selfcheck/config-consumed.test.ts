import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CONFIG_KEYS } from "../../src/lib/config.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

/** Strip // line comments and /* *\/ block comments before matching, so a key name in a comment is not treated as consumption. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const unusedKeys = (files: string[], keys: string[]): string[] => {
  const corpus = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  return keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(corpus));
};

it("every CONFIG_KEYS key is really consumed in src/ or extensions/ (excluding its definition in config.ts)", () => {
  const configFile = join(ROOT, "src/lib/config.ts");
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]
    .filter((f) => f !== configFile);
  expect(unusedKeys(files, Object.keys(CONFIG_KEYS))).toEqual([]);
});

it("a key name in a comment does not count as consumption (counterexample, MINOR)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-cfg-scan-"));
  const f = join(dir, "x.ts");
  writeFileSync(f, "// wipLimit\n/* maxTurns */\nconst used = 1;\n");
  expect(unusedKeys([f], ["wipLimit", "maxTurns"])).toEqual(["wipLimit", "maxTurns"]);
  writeFileSync(f, "const used = wipLimit;\n");
  expect(unusedKeys([f], ["wipLimit"])).toEqual([]);
});
