import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

it("F121 coverage gate: script, thresholds, and pure-type exclusion all exist", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts.coverage).toBeDefined();
  expect(pkg.scripts["coverage:check"]).toBeDefined();

  const cfg = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  expect(cfg).toContain("lines: 95");
  expect(cfg).toContain("branches: 90");
  expect(cfg).toContain("functions: 95");
  expect(cfg).toContain("src/jobs/types.ts");
});
