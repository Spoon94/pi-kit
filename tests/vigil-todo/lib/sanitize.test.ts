import { expect, it } from "vitest";
import { sanitizeTerminalText } from "../../../src/vigil-todo/lib/sanitize.js";

it("strips CSI/OSC, converts newlines to spaces, removes bidi", () => {
  expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
  expect(sanitizeTerminalText("a\nb\tc")).toBe("a b c");
  expect(sanitizeTerminalText("a‮b")).toBe("ab");
  expect(sanitizeTerminalText("\u001b]0;title\u0007x")).toBe("x");
  expect(sanitizeTerminalText("a\u0001b")).toBe("ab");
});
