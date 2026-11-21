import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { quarantine, readJsonSafe, writeJsonAtomic } from "../../src/lib/atomic.js";

const dir = () => mkdtempSync(join(tmpdir(), "vigil-atomic-"));

it("写入后可读回，且不留 tmp 文件", () => {
  const p = join(dir(), "jobs.json");
  writeJsonAtomic(p, { jobs: [{ id: "a" }] });
  expect(readJsonSafe<{ jobs: unknown[] }>(p)).toEqual({ ok: true, value: { jobs: [{ id: "a" }] } });
  expect(existsSync(`${p}.tmp`)).toBe(false);
});

it("缺文件与损坏可区分（Review Focus 2）", () => {
  const d = dir();
  expect(readJsonSafe(join(d, "nope.json"))).toEqual({ ok: false, reason: "missing" });
  const p = join(d, "bad.json"); writeFileSync(p, "{not json");
  expect(readJsonSafe(p)).toEqual({ ok: false, reason: "corrupt" });
});

it("quarantine 保留原内容供排障（F12）", () => {
  const p = join(dir(), "bad.json"); writeFileSync(p, "{not json");
  const moved = quarantine(p);
  expect(moved).toBeDefined();
  expect(readFileSync(moved!, "utf8")).toBe("{not json");
  expect(existsSync(p)).toBe(false);
});
