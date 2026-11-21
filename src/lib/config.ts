export interface VigilConfig {
  wipLimit: number; retries: number; retryDelaysMs: number[]; staleReverify: number;
  maxTurns: number; maxConcurrentJobs: number; completedTtlMs: number;
  taskRetentionMs: number;
  tailLines: number; maxTailBytes: number; maxWidgetLines: number; collapseKey: string;
  notifyRetryMs: number; heartbeatStaleMs: number; hungSuspectMs: number;
  wakeMergeMs: number; adoptRecheckMs: number;
}

export const DEFAULTS: VigilConfig = {
  wipLimit: 3, retries: 3, retryDelaysMs: [0, 30_000, 120_000], staleReverify: 1,
  maxTurns: 50, maxConcurrentJobs: 10, completedTtlMs: 7 * 24 * 3600_000,
  taskRetentionMs: 0,
  tailLines: 20, maxTailBytes: 8192, maxWidgetLines: 12, collapseKey: "ctrl+shift+t",
  notifyRetryMs: 600_000, heartbeatStaleMs: 15_000, hungSuspectMs: 600_000,
  wakeMergeMs: 250, adoptRecheckMs: 20_000,
};

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown, min: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min ? v : undefined;

/** file > settings.vigilTodo > legacy.bgRun > DEFAULTS；非法值逐项退回默认。 */
export function resolveConfig(s: { file?: unknown; settings?: unknown; legacy?: unknown }): VigilConfig {
  const layers = [s.legacy, s.settings, s.file].filter(isBag);
  const pick = (k: keyof VigilConfig): unknown => {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][k] !== undefined) return layers[i][k];
    return undefined;
  };
  const out = { ...DEFAULTS };
  const mins: Partial<Record<keyof VigilConfig, number>> = {
    wipLimit: 1, retries: 0, staleReverify: 0, maxTurns: 1, maxConcurrentJobs: 1,
    completedTtlMs: 1, taskRetentionMs: 0, tailLines: 1, maxTailBytes: 1, maxWidgetLines: 3,
    notifyRetryMs: 1, heartbeatStaleMs: 1, hungSuspectMs: 1, wakeMergeMs: 0, adoptRecheckMs: 1,
  };
  for (const [k, min] of Object.entries(mins)) {
    const v = posInt(pick(k as keyof VigilConfig), min as number);
    if (v !== undefined) (out as unknown as Bag)[k] = v;
  }
  const delays = pick("retryDelaysMs");
  if (Array.isArray(delays) && delays.length > 0 && delays.every((d) => posInt(d, 0) !== undefined)) {
    out.retryDelaysMs = delays as number[];
  }
  const key = pick("collapseKey");
  if (typeof key === "string" && key.trim() !== "") out.collapseKey = key.trim().toLowerCase();
  return out;
}

/** mtime 缓存：同一 mtime 不重复解析（规格 §10.1「每渲染读配置」缺陷）。 */
export function createConfigLoader(read: () => { mtimeMs: number; sources: { file?: unknown; settings?: unknown; legacy?: unknown } }) {
  let cached: { mtimeMs: number; config: VigilConfig } | undefined;
  return (): VigilConfig => {
    const { mtimeMs, sources } = read();
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, config: resolveConfig(sources) };
    return cached.config;
  };
}
