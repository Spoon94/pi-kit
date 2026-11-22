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

it("board/ must not import pi or extensions (pure state machine)", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/vigil-todo/board"))) {
    for (const spec of importsOf(f)) {
      if (spec.includes("@earendil-works") || spec.includes("extensions/")) bad.push(`${f} → ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

it("jobs/ must not import bind/wake/ui/tool (the job subsystem knows nothing about orchestration)", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/vigil-todo/jobs"))) {
    for (const spec of importsOf(f)) {
      if (/\/(bind|wake|ui|tool)\//.test(spec)) bad.push(`${f} → ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

it("ui/ must not call write entry points (read-only)", () => {
  const bad: string[] = [];
  for (const f of walk(join(ROOT, "src/vigil-todo/ui"))) {
    const src = readFileSync(f, "utf8");
    for (const call of [".commit(", ".put(", ".save(", "appendEntry("]) {
      if (src.includes(call)) bad.push(`${f} → ${call}`);
    }
  }
  expect(bad).toEqual([]);
});
