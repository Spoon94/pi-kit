import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractFIds, missingFIds } from "./fids.js";

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

// Acceptance numbers retired by the §17.2 scope contraction (defer / adoption / heartbeat / claims / two-set).
// F96/F99 were heartbeat/adoption cases missing from the §17.2 list; they were removed with the modules.
const RETIRED = new Set([
  18, 27, 28, 34, 39, 62, 78,
  88, 92, 93, 94, 95, 96, 97, 98, 99, 100, 104, 105,
  90, 101, 103,
  56, 57, 63, 75, 79,
]);

it("every F number in spec §13 appears in test text (spec and tests stay linked)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const table = spec.slice(spec.indexOf("## 13."), spec.indexOf("## 14."));
  const ids = extractFIds(table);
  expect(ids.length).toBeGreaterThanOrEqual(105);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(missingFIds(table, corpus).filter((n) => !RETIRED.has(n))).toEqual([]);
});

it("the F-id checker reports a missing id and accepts a present one", () => {
  expect(missingFIds("| F999 | synthetic acceptance case |", "no ids in this corpus")).toEqual([999]);
  expect(missingFIds("| F999 | synthetic acceptance case |", "test F999 exists")).toEqual([]);
});

it("the eight-aspect matrix exists and covers all eight rows", () => {
  const doc = readFileSync(join(ROOT, "docs/vigil-todo/quality-matrix.md"), "utf8");
  for (const k of ["Performance", "Resilience", "Configurability", "Usability", "Extensibility", "Self-verification", "Clearing todos", "Forced halt"]) {
    expect(doc).toContain(k);
  }
});

it("entry-level F numbers must have event-order assertions under tests/vigil-todo/integration/ (G2)", () => {
  const ENTRY_F = ["F6", "F7", "F8", "F10", "F38", "F61", "F71", "F72", "F74"];
  const corpus = walk(join(ROOT, "tests/vigil-todo/integration"))
    .map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ENTRY_F.filter((id) => !new RegExp(`\\b${id}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§18 F106-F111 all appear in test text (R21 / deadlock visibility)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const start = spec.indexOf("### 18.4");
  const end = spec.indexOf("## 19.");
  const section = spec.slice(start, end > start ? end : undefined);
  const ids = extractFIds(section);
  expect(ids).toEqual([106, 107, 108, 109, 110, 111]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§19 F112-F122 all appear in test text (completeness/guidance/truncation/coverage gate)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const start = spec.indexOf("### 19.6");
  const end = spec.indexOf("## 20.");
  const section = spec.slice(start, end > start ? end : undefined);
  const ids = extractFIds(section);
  expect(ids).toEqual([112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§20 F123-F132 all appear in test text (/vt clear)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const end = spec.indexOf("## 21.");
  const section = spec.slice(spec.indexOf("### 20.4"), end > 0 ? end : undefined);
  const ids = extractFIds(section);
  expect(ids).toEqual([123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§21 F133-F136 all appear in test text (full halt brake)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const end = spec.indexOf("## 22.");
  const section = spec.slice(spec.indexOf("### 21.3"), end > 0 ? end : undefined);
  const ids = extractFIds(section);
  expect(ids).toEqual([133, 134, 135, 136]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  const missing = ids.filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpus));
  expect(missing).toEqual([]);
});

it("§22 F137-F143 all appear in test text (onboarding)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const after = spec.slice(spec.indexOf("## 22.") + 1);
  const next = after.search(/\n## \d+\./);
  const end = next >= 0 ? spec.indexOf("## 22.") + 1 + next : -1;
  const section = spec.slice(spec.indexOf("### 22.3"), end > 0 ? end : undefined);
  const ids = extractFIds(section);
  expect(ids).toEqual([137, 138, 139, 140, 141, 142, 143]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(missingFIds(section, corpus)).toEqual([]);
});

it("§23 F148-F156 all appear in test text (fast wake)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  // §23 ships with the fast-wake PR; this branch may merge before it, so guard only when present.
  if (!spec.includes("## 23.")) return;
  const end = spec.indexOf("## 24.");
  const section = spec.slice(spec.indexOf("### 23.3"), end > 0 ? end : undefined);
  const ids = extractFIds(section);
  expect(ids.filter((n) => n >= 148)).toEqual([148, 149, 150, 151, 152, 153, 154, 155, 156]);   // §23.3 also cites F38 semantics, F152b is prose
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(missingFIds(section, corpus)).toEqual([]);
});

it("§24 F157-F164 all appear in test text (no TUI flicker)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const end = spec.indexOf("## 25.");
  const section = spec.slice(spec.indexOf("### 24.4"), end > 0 ? end : undefined);
  const ids = extractFIds(section);
  expect(ids.filter((n) => n >= 157)).toEqual([157, 158, 159, 160, 161, 162, 163, 164]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(missingFIds(section, corpus)).toEqual([]);
});

it("§25 F165-F170 all appear in test text (bg_run freshness order)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 25.4"));
  const ids = extractFIds(section);
  expect(ids.filter((n) => n >= 165)).toEqual([165, 166, 167, 168, 169, 170]);
  const corpus = walk(join(ROOT, "tests")).map((f) => readFileSync(f, "utf8")).join("\n");
  expect(missingFIds(section, corpus)).toEqual([]);
});

it("the sub-agent dispatch doc exists and covers the key boundaries (atomic flow/poller/halt/no auto re-attach)", () => {
  const doc = readFileSync(join(ROOT, "docs/vigil-todo/dispatching-agents.md"), "utf8");
  for (const needle of [
    "Two-step atomic flow",
    "Do not manually call",
    "Idempotent poller pattern",
    "cannot kill the independent agent itself",
    "No automatic re-attach",
    "duplicate the dispatch",
    "fp:stale",
    'todo({action:"verify", id})',
  ]) expect(doc, needle).toContain(needle);
  expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain("docs/vigil-todo/dispatching-agents.md");
});

it("the spec document has no duplicate top-level sections (F102)", () => {
  const spec = readFileSync(join(ROOT, "docs/vigil-todo/design/specs/2026-11-21-vigil-todo-design.md"), "utf8");
  const sections = [...spec.matchAll(/^## (\d+)\./gm)].map((m) => m[1]);
  expect(sections.length).toBeGreaterThan(10);
  expect(new Set(sections).size).toBe(sections.length);
});
