export interface ToolGuidance {
  promptSnippet: string;
  promptGuidelines: string[];
}

export const DEFAULT_GUIDANCE: ToolGuidance = {
  promptSnippet: "Track multi-step work on the task board and keep long commands off the chat thread.",
  promptGuidelines: [
    "Long-running work (training, builds, full test suites) MUST use bg_run, not bash. Start it, end your turn; completion wakes you.",
    "Keep exactly one todo in_progress (WIP=1). Finish it or park it before starting another.",
    "park requires a non-empty reason. Parked tasks do not occupy WIP; continue tasks that do not depend on them.",
    "Only mark completed with real evidence. Failures cannot be completed. accept:\"stale\" is an explicit, logged waiver.",
    "clear defaults to completed/deleted only. scope:\"all\" requires force:true and no running or backoff jobs.",
    "When woken, act on the message's next item directly; do not ask whether to continue.",
  ],
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const guidanceOf = (layer: unknown): unknown => isBag(layer) ? layer.guidance : undefined;

/** 与 resolveConfig 同一优先级链：file > settings.vigilTodo > legacy.bgRun > 默认。 */
export function resolveGuidance(s: { file?: unknown; settings?: unknown; legacy?: unknown }): ToolGuidance {
  const layers = [guidanceOf(s.legacy), guidanceOf(s.settings), guidanceOf(s.file)].filter(isBag);
  const pick = (fn: (g: Bag) => unknown): unknown => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = fn(layers[i]);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const snippetRaw = pick((g) => g.promptSnippet);
  const snippet = typeof snippetRaw === "string" && snippetRaw.trim() !== ""
    ? snippetRaw.trim()
    : DEFAULT_GUIDANCE.promptSnippet;

  const linesRaw = pick((g) => g.promptGuidelines);
  const lines = Array.isArray(linesRaw)
    ? linesRaw.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim())
    : [];
  const promptGuidelines = lines.length > 0 ? lines : DEFAULT_GUIDANCE.promptGuidelines;

  return { promptSnippet: snippet, promptGuidelines };
}

/** 与 createConfigLoader 相同的 stat/read 缓存契约。 */
export function createGuidanceLoader(input: {
  stat(): { mtimeMs: number; settingsKey: string };
  read(): { file?: unknown; settings?: unknown; legacy?: unknown };
}) {
  let cached: { key: string; guidance: ToolGuidance } | undefined;
  return (): ToolGuidance => {
    const { mtimeMs, settingsKey } = input.stat();
    const key = `${mtimeMs}|${settingsKey}`;
    if (!cached || cached.key !== key) cached = { key, guidance: resolveGuidance(input.read()) };
    return cached.guidance;
  };
}
