import { expect, it } from "vitest";
import { createOverlayController } from "../../src/ui/overlay.js";
import { emptyBoard } from "../../src/board/types.js";

it("headless 时全部 no-op（Review Focus 5）", () => {
  let calls = 0;
  const c = createOverlayController({ hasUI: () => false, setWidget: () => { calls++; } });
  c.update(emptyBoard());
  expect(calls).toBe(0);
});

it("空列表卸载 widget；非空注册", () => {
  const set: (string | undefined)[] = [];
  const c = createOverlayController({ hasUI: () => true, setWidget: (k) => { set.push(k); } });
  c.update(emptyBoard());
  const b = emptyBoard(); b.tasks = [{ id: 1, subject: "a", status: "pending" }];
  c.update(b);
  expect(set).toEqual([undefined, "vigil-todo"]);
  expect(c.isRegistered()).toBe(true);
  c.dispose();
  expect(c.isRegistered()).toBe(false);
  expect(set.at(-1)).toBeUndefined();
});
