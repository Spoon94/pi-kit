import type { BoardState } from "../board/types.js";
import { selectNext } from "../board/selectors.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";
import { DEFAULT_GUIDANCE, type ToolGuidance } from "./guidance.js";

export type OnboardingMode = "off" | "once" | "live";

/** Hard cap for the whole injected text (spec §22). */
export const ONBOARDING_MAX = 1200;
const SUBJECT_MAX = 80;

const BASE = "vigil-todo: at the start of a new instruction, capture multi-step work with todo create before acting "
  + "when it spans 3+ steps, multiple files, or long-running commands. Long-running commands use bg_run, not bash; "
  + "start the job, end the turn, and let the completion wake you. Keep exactly one todo in_progress.";

const cut = (value: string, max: number): string => {
  const clean = sanitizeTerminalText(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Base sentence; a configured override keeps the same priority chain as the rest of guidance. */
export function baseOnboardingText(guidance: ToolGuidance = DEFAULT_GUIDANCE): string {
  const custom = guidance.onboardingText;
  return typeof custom === "string" && custom.trim() !== "" ? custom.trim() : BASE;
}

/** Light board digest: current WIP plus the next actionable task (informational, bypasses WIP gating). */
export function buildBoardSummary(board: BoardState): string {
  const wip = board.tasks.filter((t) => t.status === "in_progress");
  const next = selectNext(board, wip.length + 1, false);
  const wipText = wip.length
    ? wip.map((t) => `#${t.id} ${cut(t.subject ?? "", SUBJECT_MAX)}`).join(", ")
    : "none";
  const nextText = next ? `#${next.id} ${cut(next.subject ?? "", SUBJECT_MAX)}` : "none";
  return `Current board: WIP ${wipText}; next ${nextText}.`;
}

/** Pure: no I/O, no timers. Empty text means "inject nothing". */
export function buildOnboardingPrompt(
  board: BoardState, guidance: ToolGuidance = DEFAULT_GUIDANCE, mode: OnboardingMode = "live",
): string {
  if (mode === "off") return "";
  const parts = [baseOnboardingText(guidance)];
  if (mode === "live" && board.tasks.length > 0) parts.push(buildBoardSummary(board));
  const text = parts.join("\n");
  return text.length <= ONBOARDING_MAX ? text : `${text.slice(0, ONBOARDING_MAX - 1)}…`;
}

/** Identity of everything the digest reads, so an unchanged board keeps a byte-identical prompt. */
export function boardSignature(board: BoardState): string {
  const wip = board.tasks.filter((t) => t.status === "in_progress");
  const next = selectNext(board, wip.length + 1, false);
  return [
    board.tasks.length,
    wip.map((t) => `${t.id}:${t.subject ?? ""}`).join("|"),
    next ? `${next.id}:${next.subject ?? ""}` : "",
  ].join("\u0000");
}

/** Memoized builder: recompute only when the mode, the guidance text, or the board signature changes. */
export function createOnboardingCache(): (board: BoardState, guidance: ToolGuidance, mode: OnboardingMode) => string {
  let key = "";
  let text = "";
  return (board, guidance, mode) => {
    const nextKey = `${mode}\u0000${guidance.onboardingText ?? ""}\u0000${boardSignature(board)}`;
    if (nextKey !== key) {
      key = nextKey;
      text = buildOnboardingPrompt(board, guidance, mode);
    }
    return text;
  };
}
