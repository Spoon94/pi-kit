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

it("retired mechanisms cannot return: src/ and extensions/ contain no defer/adopt/heartbeat/claims/adoptedAway", () => {
  const banned = [/\bdefer\b/i, /\badopt\w*/i, /\bheartbeat\w*/i, /\bclaims?\b/i, /adoptedAway/];
  const hits: string[] = [];
  for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]) {
    const src = readFileSync(f, "utf8");
    for (const re of banned) if (re.test(src)) hits.push(`${f} matches ${re}`);
  }
  expect(hits).toEqual([]);
});

it("the three retired files really do not exist", () => {
  for (const p of ["src/vigil-todo/jobs/claims.ts", "src/vigil-todo/jobs/heartbeat.ts", "src/vigil-todo/bind/adopt.ts"]) {
    expect(() => statSync(join(ROOT, p))).toThrow();
  }
});

it("default WIP is 1 (the model focuses on one todo at a time)", async () => {
  const { DEFAULTS } = await import("../../src/vigil-todo/lib/config.js");
  expect(DEFAULTS.wipLimit).toBe(1);
});
