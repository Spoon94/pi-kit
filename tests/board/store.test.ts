import { expect, it } from "vitest";
import { createBoardStore } from "../../src/board/store.js";
import { emptyBoard } from "../../src/board/types.js";

it("会话隔离，互不串写（F10 基础）", () => {
  const s = createBoardStore();
  const a = emptyBoard(); a.tasks.push({ id: 1, subject: "a", status: "pending" });
  s.commit("A", a);
  expect(s.get("B").tasks).toHaveLength(0);
  expect(s.get("A").tasks).toHaveLength(1);
  s.evict("A");
  expect(s.get("A").tasks).toHaveLength(0);
});

it("前台指针决定 renderState", () => {
  const s = createBoardStore();
  const a = emptyBoard(); a.tasks.push({ id: 1, subject: "a", status: "pending" });
  s.commit("A", a); s.setForeground("A");
  expect(s.renderState().tasks).toHaveLength(1);
  expect(s.foreground()).toBe("A");
});
