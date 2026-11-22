import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // perf 承诺 p95<3ms；文件串行运行，避免与其他测试文件争 CPU 造成假失败
    fileParallelism: false,
    // B3 soak：允许测试显式触发 GC，测量真实堆增长
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "extensions/**/*.ts"],
      exclude: ["src/vigil-todo/jobs/types.ts"],   // 纯类型文件
      reporter: ["text", "json-summary"],
      thresholds: { lines: 95, branches: 90, functions: 95 },
    },
  },
});
