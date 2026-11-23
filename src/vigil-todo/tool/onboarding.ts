import type { BoardState } from "../board/types.js";
import { selectNext } from "../board/selectors.js";
import { sanitizeTerminalText } from "../lib/sanitize.js";
import { DEFAULT_GUIDANCE, type ToolGuidance } from "./guidance.js";

export type OnboardingMode = "off" | "once" | "live";

/** Dedicated system-prompt section key: assigning it replaces our previous digest instead of appending. */
export const ONBOARDING_SECTION = "vigil-todo-board";

/** Hard cap for the whole injected text (spec §22). */
export const ONBOARDING_MAX = 1200;
/** Room reserved for the section XML wrapper so base + digest + markers stay under the cap. */
const SECTION_OVERHEAD = 32;
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
  const custom = guidance.onboardingPromptText;
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

const cap = (text: string): string => (
  text.length <= ONBOARDING_MAX ? text : `${text.slice(0, ONBOARDING_MAX - 1)}…`
);

export interface OnboardingInjection {
  /** Base sentence for `appendSystemPrompt` (empty means inject nothing). */
  append: string;
  /** Board digest for the dedicated section key (undefined means "no section"). */
  board?: string;
}

/**
 * Split form used by the extension: the base sentence goes to `appendSystemPrompt` (added once),
 * the digest goes to `sections[ONBOARDING_SECTION]` so a new board replaces the old one instead of
 * stacking. Pure: no I/O, no timers.
 */
export function buildOnboardingInjection(
  board: BoardState, guidance: ToolGuidance = DEFAULT_GUIDANCE, mode: OnboardingMode = "live",
): OnboardingInjection {
  if (mode === "off") return { append: "" };
  const base = cap(baseOnboardingText(guidance));
  if (mode !== "live" || board.tasks.length === 0) return { append: base };
  const room = ONBOARDING_MAX - SECTION_OVERHEAD - base.length - 1;
  if (room <= 0) return { append: base };
  let summary = buildBoardSummary(board);
  if (summary.length > room) summary = `${summary.slice(0, Math.max(0, room - 1))}…`;
  return summary ? { append: base, board: summary } : { append: base };
}

/** Combined text (base + digest), used by docs/tests; the extension injects the split form above. */
export function buildOnboardingPrompt(
  board: BoardState, guidance: ToolGuidance = DEFAULT_GUIDANCE, mode: OnboardingMode = "live",
): string {
  const { append, board: digest } = buildOnboardingInjection(board, guidance, mode);
  if (!append) return "";
  return cap(digest ? `${append}\n${digest}` : append);
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
export function createOnboardingCache(): (board: BoardState, guidance: ToolGuidance, mode: OnboardingMode) => OnboardingInjection {
  let key = "";
  let cached: OnboardingInjection = { append: "" };
  return (board, guidance, mode) => {
    const nextKey = `${mode}\u0000${guidance.onboardingPromptText ?? ""}\u0000${boardSignature(board)}`;
    if (nextKey !== key) {
      key = nextKey;
      cached = buildOnboardingInjection(board, guidance, mode);
    }
    return cached;
  };
}
