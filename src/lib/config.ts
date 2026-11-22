export interface VigilConfig {
  wipLimit: number; retries: number; retryDelaysMs: number[]; staleReverify: number;
  maxTurns: number; maxConcurrentJobs: number; completedTtlMs: number;
  taskRetentionMs: number;
  tailLines: number; maxTailBytes: number; maxWidgetLines: number; collapseKey: string;
  notifyRetryMs: number;
  wakeMergeMs: number;
}

export const DEFAULTS: VigilConfig = {
  wipLimit: 1, retries: 3, retryDelaysMs: [0, 30_000, 120_000], staleReverify: 1,
  maxTurns: 50, maxConcurrentJobs: 10, completedTtlMs: 7 * 24 * 3600_000,
  taskRetentionMs: 0,
  tailLines: 20, maxTailBytes: 8192, maxWidgetLines: 12, collapseKey: "ctrl+shift+t",
  notifyRetryMs: 600_000,
  wakeMergeMs: 250,
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);

export const CONFIG_KEYS: Record<keyof VigilConfig, { type: "int" | "int[]" | "string"; min?: number; max?: number; reload: boolean; default: unknown }> = {
  wipLimit: { type: "int", min: 1, max: 100, reload: false, default: DEFAULTS.wipLimit },
  retries: { type: "int", min: 0, max: 20, reload: false, default: DEFAULTS.retries },
  retryDelaysMs: { type: "int[]", min: 0, max: 3_600_000, reload: false, default: DEFAULTS.retryDelaysMs },
  staleReverify: { type: "int", min: 0, max: 10, reload: false, default: DEFAULTS.staleReverify },
  maxTurns: { type: "int", min: 1, max: 10_000, reload: false, default: DEFAULTS.maxTurns },
  maxConcurrentJobs: { type: "int", min: 1, max: 200, reload: false, default: DEFAULTS.maxConcurrentJobs },
  completedTtlMs: { type: "int", min: 1, max: 365 * 24 * 3600_000, reload: false, default: DEFAULTS.completedTtlMs },
  taskRetentionMs: { type: "int", min: 0, max: 365 * 24 * 3600_000, reload: false, default: DEFAULTS.taskRetentionMs },
  tailLines: { type: "int", min: 1, max: 500, reload: false, default: DEFAULTS.tailLines },
  maxTailBytes: { type: "int", min: 1, max: 1_048_576, reload: false, default: DEFAULTS.maxTailBytes },
  maxWidgetLines: { type: "int", min: 3, max: 200, reload: false, default: DEFAULTS.maxWidgetLines },
  collapseKey: { type: "string", reload: true, default: DEFAULTS.collapseKey },
  notifyRetryMs: { type: "int", min: 1, max: 86_400_000, reload: false, default: DEFAULTS.notifyRetryMs },
  wakeMergeMs: { type: "int", min: 0, max: 60_000, reload: false, default: DEFAULTS.wakeMergeMs },
};

const posInt = (v: unknown, min: number, max?: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && (max === undefined || v <= max) ? v : undefined;

/** file > settings.vigilTodo > legacy.bgRun > DEFAULTS；非法/超限值逐项退回默认。 */
export function resolveConfig(s: { file?: unknown; settings?: unknown; legacy?: unknown }): VigilConfig {
  const layers = [s.legacy, s.settings, s.file].filter(isBag);
  const pick = (k: keyof VigilConfig): unknown => {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][k] !== undefined) return layers[i][k];
    return undefined;
  };
  const out = { ...DEFAULTS };
  for (const [k, meta] of Object.entries(CONFIG_KEYS)) {
    if (meta.type === "int") {
      const v = posInt(pick(k as keyof VigilConfig), meta.min ?? 0, meta.max);
      if (v !== undefined) (out as unknown as Bag)[k] = v;
    } else if (meta.type === "int[]") {
      const arr = pick(k as keyof VigilConfig);
      if (Array.isArray(arr) && arr.length > 0
        && arr.every((d) => posInt(d, meta.min ?? 0, meta.max) !== undefined)) {
        (out as unknown as Bag)[k] = arr as number[];
      }
    }
  }
  const key = pick("collapseKey");
  if (typeof key === "string" && key.trim() !== "") out.collapseKey = key.trim().toLowerCase();
  return out;
}

/** stat 与读取分离：stat 每渲染都跑，文件读取/解析只在 mtime 或 settings 变化时发生。 */
export function createConfigLoader(input: {
  stat(): { mtimeMs: number; settingsKey: string };
  read(): { file?: unknown; settings?: unknown; legacy?: unknown };
}) {
  let cached: { key: string; config: VigilConfig } | undefined;
  return (): VigilConfig => {
    const { mtimeMs, settingsKey } = input.stat();
    const key = `${mtimeMs}|${settingsKey}`;
    if (!cached || cached.key !== key) cached = { key, config: resolveConfig(input.read()) };
    return cached.config;
  };
}
