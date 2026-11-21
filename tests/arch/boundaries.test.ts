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
const importsOf = (f: string): string[] =>
  [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

it("board/ 不得 import pi 或 extensions（纯状态机）", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/board"))) {
    for (const spec of importsOf(f)) {
      if (spec.includes("@earendil-works") || spec.includes("extensions/")) bad.push(`${f} → ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

it("jobs/ 不得 import bind/wake/ui/tool（作业子系统不懂编排）", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/jobs"))) {
    for (const spec of importsOf(f)) {
      if (/\/(bind|wake|ui|tool)\//.test(spec)) bad.push(`${f} → ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

it("ui/ 不得调用写入口（只读）", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/ui"))) {
    const src = readFileSync(f, "utf8");
    for (const call of [".commit(", ".put(", ".save(", "appendEntry("]) {
      if (src.includes(call)) bad.push(`${f} → ${call}`);
    }
  }
  expect(bad).toEqual([]);
});
