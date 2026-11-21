import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readLiveness, removeHeartbeat, writeHeartbeat } from "../../src/jobs/heartbeat.js";

const dir = () => mkdtempSync(join(tmpdir(), "{{SECRET_5mid0w3a}}"));

it("新鲜心跳判活跃", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 1000, 15_000, 600_000)).toBe("active");
});

it("心跳过期但 pid 存活且未超挂死阈值 → 仍活跃（合盖场景）", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 20_000, 15_000, 600_000)).toBe("active");
});

it("pid 存活但停更超挂死阈值 → suspect（F98）", () => {
  const d = dir();
  writeHeartbeat(d, "S", process.pid, 1000);
  expect(readLiveness(d, "S", 700_000, 15_000, 600_000)).toBe("suspect");
});

it("pid 已死且心跳过期 → inactive（F96）", () => {
  const d = dir();
  writeHeartbeat(d, "S", 999_999, 1000);
  expect(readLiveness(d, "S", 30_000, 15_000, 600_000)).toBe("inactive");
});

it("无心跳文件 → inactive；remove 后同样", () => {
  const d = dir();
  expect(readLiveness(d, "S", 1, 15_000, 600_000)).toBe("inactive");
  writeHeartbeat(d, "S", process.pid, 1);
  removeHeartbeat(d, "S");
  expect(readLiveness(d, "S", 1, 15_000, 600_000)).toBe("inactive");
});
