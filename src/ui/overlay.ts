import type { BoardState } from "../board/types.js";
import { WIDGET_KEY } from "./panel.js";

export interface OverlayHost {
  hasUI(): boolean;
  setWidget(key: string | undefined): void;
  render(): string[];
}

export function createOverlayController(host: OverlayHost) {
  let registered = false;
  return {
    update(state: BoardState) {
      if (!host.hasUI()) return;
      const visible = state.tasks.some((t) => t.status !== "deleted");
      if (!visible) { host.setWidget(undefined); registered = false; return; }
      if (!registered) { host.setWidget(WIDGET_KEY); registered = true; }
    },
    dispose() { if (host.hasUI() && registered) host.setWidget(undefined); registered = false; },
    isRegistered: () => registered,
  };
}
