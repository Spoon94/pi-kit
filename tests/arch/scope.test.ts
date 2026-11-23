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

const probes: string[] = [];
const cleanup = (): void => {
  for (const p of probes.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* already gone */ }
  }
};
afterEach(cleanup);

const bannedHits = (): string[] => {
  const banned = [/\bdefer\b/i, /\badopt\w*/i, /\bheartbeat\w*/i, /\bclaims?\b/i, /adoptedAway/];
  const hits: string[] = [];
  for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "extensions"))]) {
    const src = readFileSync(f, "utf8");
    for (const re of banned) if (re.test(src)) hits.push(`${f} matches ${re}`);
  }
  return hits;
};

it("retired mechanisms cannot return: src/ and extensions/ contain no defer/adopt/heartbeat/claims/adoptedAway", () => {
  expect(bannedHits()).toEqual([]);
});

it("permanent negative: a retired-mechanism probe is detected", () => {
  const probe = join(ROOT, "src/vigil-todo/jobs/__probe_scope.ts");
  probes.push(probe);
  try {
    writeFileSync(probe, 'export const marker = "defer";\n');
    expect(bannedHits().some((h) => h.startsWith(probe))).toBe(true);
  } finally {
    cleanup();
  }
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
