import { expect, it } from "vitest";
import { formatElapsed } from "../../src/lib/format.js";

it("耗时格式：s / m s / h m（§7.5 / §8.1）", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(4_500)).toBe("4s");
  expect(formatElapsed(192_000)).toBe("3m12s");
  expect(formatElapsed(130_000)).toBe("2m10s");
  expect(formatElapsed(3_900_000)).toBe("1h5m");
});
