export const GUIDANCE_TOOLS = ["todo", "bg_run", "bg_list", "bg_kill"] as const;
export type GuidanceTool = (typeof GUIDANCE_TOOLS)[number];

export interface ToolGuidance {
  /** Global fallback snippet (backward compatible; per-tool snippets take priority). */
  promptSnippet: string;
  promptGuidelines: string[];
  snippets: Record<GuidanceTool, string>;
  /** Optional replacement for the onboarding base sentence (spec §22). */
  onboardingPromptText?: string;
}

export const DEFAULT_GUIDANCE: ToolGuidance = {
  promptSnippet: "Track multi-step work on the task board and keep long commands off the chat thread.",
  snippets: {
    todo: "Plan and track multi-step work; state transitions and completion evidence are enforced by the tool.",
    bg_run: "Run a long command in the background bound to a task; completion wakes you (never use bash for long work).",
    bg_list: "Inspect background jobs, statuses, exit codes, and logs.",
    bg_kill: "Cancel a background job chain, including its retries and backoff.",
  },
  promptGuidelines: [
    "At the start of a new instruction, capture multi-step work with todo create before acting when it spans 3+ steps, multiple files, or long-running commands. Skip trivial questions.",
    "Long-running work (training, builds, full test suites) MUST use bg_run, not bash. Start it, end your turn; completion wakes you.",
    "Keep exactly one todo in_progress (WIP=1). Finish it or park it before starting another.",
    "park requires a non-empty reason. Parked tasks do not occupy WIP; continue tasks that do not depend on them.",
    "Only mark completed with real evidence. Failures cannot be completed. accept:\"stale\" is an explicit, logged waiver.",
    "clear defaults to completed/deleted only. scope:\"all\" requires force:true and no running or backoff jobs.",
    "When woken, act on the message's next item directly; do not ask whether to continue.",
    "If the user says they are going to sleep, wants an overnight/batch run, or asks for work to continue in the background, proactively create a todo and start bg_run without waiting for the tool name. Tell them `/vt halt` stops everything immediately.",
  ],
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const guidanceOf = (layer: unknown): unknown => isBag(layer) ? layer.guidance : undefined;
const cookie = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Same priority chain as resolveConfig: file > settings.vigilTodo > legacy.bgRun > default. */
export function resolveGuidance(s: { file?: unknown; settings?: unknown; legacy?: unknown }): ToolGuidance {
  const layers = [guidanceOf(s.legacy), guidanceOf(s.settings), guidanceOf(s.file)].filter(isBag);

  const pickGlobal = (): string | undefined => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = cookie(layers[i].promptSnippet);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const global = pickGlobal();

  const snippets = {} as Record<GuidanceTool, string>;
  for (const tool of GUIDANCE_TOOLS) {
    let chosen: string | undefined;
    for (let i = layers.length - 1; i >= 0 && chosen === undefined; i--) {
      const per = layers[i].snippets;
      const perTool = isBag(per) ? cookie(per[tool]) : undefined;
      if (perTool !== undefined) chosen = perTool;
      else chosen = cookie(layers[i].promptSnippet);   // this layer's global falls back for that tool
    }
    snippets[tool] = chosen ?? DEFAULT_GUIDANCE.snippets[tool];
  }

  const linesRaw = (() => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = layers[i].promptGuidelines;
      if (v !== undefined) return v;
    }
    return undefined;
  })();
  const lines = Array.isArray(linesRaw)
    ? linesRaw.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trim())
    : [];
  const promptGuidelines = lines.length > 0 ? lines : DEFAULT_GUIDANCE.promptGuidelines;

  const onboardingPromptText = (() => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = cookie(layers[i].onboardingPromptText);
      if (v !== undefined) return v;
    }
    return undefined;
  })();

  return { promptSnippet: global ?? DEFAULT_GUIDANCE.promptSnippet, promptGuidelines, snippets, onboardingPromptText };
}

/** Same stat/read cache contract as createConfigLoader. */
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
