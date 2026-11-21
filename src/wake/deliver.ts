import { selectNext } from "../board/selectors.js";
import type { BoardCounters, BoardState } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { VigilConfig } from "../lib/config.js";
import { composeWake } from "./compose.js";

export interface DeliverInput {
  board: BoardState; jobs: JobStore; cfg: VigilConfig; now: number;
  trigger: "async" | "boundary"; modelAdvanced: boolean; capacityFull: boolean;
}
export type DeliverResult =
  | { kind: "none" }
  | { kind: "deliver"; wakeId: string; roots: string[]; text: string; counters: BoardCounters; renudge: boolean };

let wakeSeq = 0;

export function tryDeliver(i: DeliverInput): DeliverResult {
  if (i.board.counters.halted) return { kind: "none" };           // R20：人的刹车早于一切
  const c = i.board.counters;
  if (c.turnsUsed >= i.cfg.maxTurns) return { kind: "none" };      // ★ 第一行硬闸门

  const pending = i.board.tasks.flatMap((t) => t.evidence ?? [])
    .filter((e) => e.origin === "async" && e.chainFinal && e.trigger !== "self" && e.at > c.wakeWatermark);

  const next = selectNext(i.board, i.cfg.wipLimit, i.capacityFull);

  if (pending.length > 0) {
    const roots = [...new Set(pending.map((e) => e.ref).filter((r): r is string => typeof r === "string"))];
    const counters: BoardCounters = {
      turnsUsed: c.turnsUsed + 1,
      wakeWatermark: Math.max(...pending.map((e) => e.at)),
      renudgeBudget: 1,
    };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots,
      text: composeWake(roots, i.board, i.jobs, i.cfg, next), counters, renudge: false };
  }

  if (i.trigger === "boundary" && c.renudgeBudget > 0 && !i.modelAdvanced && next) {
    const counters: BoardCounters = { ...c, turnsUsed: c.turnsUsed + 1, renudgeBudget: c.renudgeBudget - 1 };
    return { kind: "deliver", wakeId: `w${Date.now().toString(36)}${wakeSeq++}`, roots: [],
      text: composeWake([], i.board, i.jobs, i.cfg, next), counters, renudge: true };
  }
  return { kind: "none" };
}
