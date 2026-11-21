import { expect, it } from "vitest";
import { sanitizeTerminalText } from "../../src/lib/sanitize.js";

it("清除 CSI/OSC、换行转空格、去 bidi", () => {
  expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
  expect(sanitizeTerminalText("a\nb\tc")).toBe("a b c");
  expect(sanitizeTerminalText("a‮b")).toBe("ab");
  expect(sanitizeTerminalText("\u001b]0;title\u0007x")).toBe("x");
});
