import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

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

it("规格 §13 的每个 F 编号都在测试文本中出现（规格与测试不脱节）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const table = spec.slice(spec.indexOf("## 13. 验收用例"), spec.indexOf("## 14."));
  const ids = [...new Set([...table.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  expect(ids.length).toBeGreaterThanOrEqual(105);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("八方面矩阵文档存在且覆盖 8 行", () => {
  const doc = readFileSync(join(ROOT, "docs/quality-matrix.md"), "utf8");
  for (const k of ["性能", "容灾", "可自定义", "易用性", "可扩展性", "自验证", "清理", "强制中断"]) {
    expect(doc).toContain(k);
  }
});

it("规格文档无重复顶层章节（F102）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const sections = [...spec.matchAll(/^## (\d+)\./gm)].map((m) => m[1]);
  expect(sections.length).toBeGreaterThan(10);
  expect(new Set(sections).size).toBe(sections.length);
});
