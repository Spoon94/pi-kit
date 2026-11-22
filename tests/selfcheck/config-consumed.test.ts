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

/** 剥掉 // 行注释与 /* *\/ 块注释后再匹配，避免“注释里写了键名”被当作消费。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const unusedKeys = (files: string[], keys: string[]): string[] => {
  const corpus = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  return keys.filter((key) => !new RegExp(`\\b${key}\\b`).test(corpus));
};

it("CONFIG_KEYS 每个键都在 src/ 或 extensions/ 被真实消费（排除 config.ts 定义处）", () => {
  const configFile = join(ROOT, "src/lib/config.ts");
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]
    .filter((f) => f !== configFile);
  expect(unusedKeys(files, Object.keys(CONFIG_KEYS))).toEqual([]);
});

it("注释里的键名不算消费（反例，MINOR）", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-cfg-scan-"));
  const f = join(dir, "x.ts");
  writeFileSync(f, "// wipLimit\n/* maxTurns */\nconst used = 1;\n");
  expect(unusedKeys([f], ["wipLimit", "maxTurns"])).toEqual(["wipLimit", "maxTurns"]);
  writeFileSync(f, "const used = wipLimit;\n");
  expect(unusedKeys([f], ["wipLimit"])).toEqual([]);
});
