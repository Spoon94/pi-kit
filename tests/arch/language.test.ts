import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

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
const probes: string[] = [];
const cleanup = (): void => {
  for (const p of probes.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* already gone */ }
  }
};
afterEach(cleanup);

const scan = (dirs: readonly string[] = ["src", "extensions", "tests"]): string[] => {
  const hits: string[] = [];
  for (const dir of dirs) {
    for (const f of walk(join(ROOT, dir))) {
      if (CJK.test(readFileSync(f, "utf8"))) hits.push(f);
    }
  }
  return hits;
};

it("src/, extensions/ and tests/ contain no CJK characters", () => {
  expect(scan()).toEqual([]);
});

it("permanent negative: a CJK probe in a scanned directory is detected", () => {
  const probe = join(ROOT, "src/vigil-todo/lib/__probe_language.ts");
  probes.push(probe);
  try {
    writeFileSync(probe, `export const marker = "${String.fromCharCode(0x4e2d, 0x6587)}";\n`);
    expect(scan()).toContain(probe);
  } finally {
    cleanup();
  }
});

it("the language guard excludes only the internal design archive", () => {
  expect(() => statSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"))).not.toThrow();
  expect(() => statSync(join(ROOT, "docs/vigil-todo/design/plans/2026-11-21-vigil-todo.md"))).not.toThrow();
});
