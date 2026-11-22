import { expect, it } from "vitest";
import { createOverlayController } from "../../../src/vigil-todo/ui/overlay.js";
import { emptyBoard } from "../../../src/vigil-todo/board/types.js";

it("all no-ops when headless (Review Focus 5)", () => {
  let calls = 0;
  const c = createOverlayController({ hasUI: () => false, setWidget: () => { calls++; } });
  c.update(emptyBoard());
  expect(calls).toBe(0);
});

it("empty list unloads the widget; non-empty registers", () => {
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
