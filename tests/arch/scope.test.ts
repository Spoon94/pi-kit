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

it("已废机制不得回潮：src/ 与 extensions/ 无 defer/adopt/heartbeat/claims/adoptedAway", () => {
  const banned = [/\bdefer\b/i, /\badopt\w*/i, /\bheartbeat\w*/i, /\bclaims?\b/i, /adoptedAway/];
  const hits: string[] = [];
  for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]) {
    const src = readFileSync(f, "utf8");
    for (const re of banned) if (re.test(src)) hits.push(`${f} matches ${re}`);
  }
  expect(hits).toEqual([]);
});

it("三个已废文件确实不存在", () => {
  for (const p of ["src/jobs/claims.ts", "src/jobs/heartbeat.ts", "src/bind/adopt.ts"]) {
    expect(() => statSync(join(ROOT, p))).toThrow();
  }
});

it("WIP 默认归 1（模型串行专注一个 todo）", async () => {
  const { DEFAULTS } = await import("../../src/lib/config.js");
  expect(DEFAULTS.wipLimit).toBe(1);
});
