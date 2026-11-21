import { expect, it } from "vitest";
import { prepareTodoArguments } from "../../src/tool/schema.js";

it("双重编码的 tasks[] 被解开（Review Focus 1）", () => {
  const raw = { action: "create", tasks: JSON.stringify([{ subject: "a" }, JSON.stringify({ subject: "b" })]) };
  const out = prepareTodoArguments(raw) as { tasks: { subject: string }[] };
  expect(out.tasks.map((t) => t.subject)).toEqual(["a", "b"]);
});

it("正常参数原样返回", () => {
  const raw = { action: "create", subject: "a" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});

it("非法 JSON 不抛，原样透传", () => {
  const raw = { action: "create", tasks: "{not json" };
  expect(prepareTodoArguments(raw)).toBe(raw);
});
