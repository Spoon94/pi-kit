import { expect, it } from "vitest";
import { prepareTodoArguments } from "../../src/tool/schema.js";

it("Double-encoded tasks[] is decoded (Review Focus 1)", () => {
  const raw = { action: "create", tasks: JSON.stringify([{ subject: "a" }, JSON.stringify({ subject: "b" })]) };
  const out = prepareTodoArguments(raw) as { tasks: { subject: string }[] };
  expect(out.tasks.map((t) => t.subject)).toEqual(["a", "b"]);
});

it("Normal arguments are returned as-is", () => {
  const raw = { action: "create", subject: "a" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});

it("Invalid JSON does not throw and passes through unchanged", () => {
  const raw = { action: "create", tasks: "{not json" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});
