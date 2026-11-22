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

// §17.2 范围收缩后已废的验收编号（defer / 收养 / 心跳 / 认领 / 两集合）
// F96/F99 是 §17.2 列表漏列的心跳/收养用例，随模块删除，一并排除。
const RETIRED = new Set([
  18, 27, 28, 34, 39, 62, 78,
  88, 92, 93, 94, 95, 96, 97, 98, 99, 100, 104, 105,
  90, 101, 103,
  56, 57, 63, 75, 79,
]);

it("规格 §13 的每个 F 编号都在测试文本中出现（规格与测试不脱节）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const table = spec.slice(spec.indexOf("## 13. 验收用例"), spec.indexOf("## 14."));
  const ids = [...new Set([...table.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  expect(ids.length).toBeGreaterThanOrEqual(105);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !RETIRED.has(n) && !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("八方面矩阵文档存在且覆盖 8 行", () => {
  const doc = readFileSync(join(ROOT, "docs/quality-matrix.md"), "utf8");
  for (const k of ["性能", "容灾", "可自定义", "易用性", "可扩展性", "自验证", "清理", "强制中断"]) {
    expect(doc).toContain(k);
  }
});

it("入口级 F 编号必须在 tests/integration/ 有事件顺序断言（G2）", () => {
  const ENTRY_F = ["F6", "F7", "F8", "F10", "F38", "F61", "F71", "F72", "F74"];
  const corpus = walk(join(ROOT, "tests/integration"))
    .map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ENTRY_F.filter((id) => !new RegExp(`\\b${id}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§18 的 F106-F111 都在测试文本中出现（R21 / 死锁可见性）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const start = spec.indexOf("### 18.4");
  const end = spec.indexOf("## 19.");
  const section = spec.slice(start, end > start ? end : undefined);
  const ids = [...new Set([...section.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  expect(ids).toEqual([106, 107, 108, 109, 110, 111]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§19 的 F112-F122 都在测试文本中出现（功能完备性/指引/截断/覆盖门禁）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 19.6"));
  const ids = [...new Set([...section.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  expect(ids).toEqual([112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("规格文档无重复顶层章节（F102）", () => {
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const sections = [...spec.matchAll(/^## (\d+)\./gm)].map((m) => m[1]);
  expect(sections.length).toBeGreaterThan(10);
  expect(new Set(sections).size).toBe(sections.length);
});
