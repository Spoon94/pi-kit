import { readdirSync, readFileSync, statSync } from "node:fs";
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

it("CONFIG_KEYS 每个键都在 src/ 或 extensions/ 被消费（排除 config.ts 定义处）", () => {
  const configFile = join(ROOT, "src/lib/config.ts");
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]
    .filter((f) => f !== configFile);
  const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const unused = Object.keys(CONFIG_KEYS)
    .filter((key) => !new RegExp(`\\b${key}\\b`).test(corpus));
  expect(unused).toEqual([]);
});
