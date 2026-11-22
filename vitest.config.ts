import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "extensions/**/*.ts"],
      exclude: ["src/jobs/types.ts"],   // 纯类型文件
      reporter: ["text", "json-summary"],
      thresholds: { lines: 95, branches: 90, functions: 95 },
    },
  },
});
