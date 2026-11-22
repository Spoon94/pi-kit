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

const CJK = new RegExp("[\\u4e00-\\u9fff]");

it("src/, extensions/ and tests/ contain no CJK characters", () => {
  const hits: string[] = [];
  for (const dir of ["src", "extensions", "tests"]) {
    for (const f of walk(join(ROOT, dir))) {
      if (CJK.test(readFileSync(f, "utf8"))) hits.push(f);
    }
  }
  expect(hits).toEqual([]);
});

it("the language guard excludes only the internal design archive", () => {
  expect(() => statSync(join(ROOT, "docs/superpowers/specs/2026-11-21-vigil-todo-design.md"))).not.toThrow();
  expect(() => statSync(join(ROOT, "docs/superpowers/plans/2026-11-21-vigil-todo.md"))).not.toThrow();
});
