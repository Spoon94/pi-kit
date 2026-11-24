/** Uniform elapsed-time format: s / m s / h m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m${s}s`;
}

/** Floor `now` to the configured granularity so repeated renders inside one bucket are identical. */
export function quantizeNow(now: number, granMs: number): number {
  const g = Math.max(1000, granMs);
  return now - (now % g);
}

/** Coarse elapsed time for the live panel: minutes by default, seconds only when granularity <= 1s. */
export function formatElapsedCoarse(ms: number, granMs = 60_000): string {
  if (granMs <= 1000) return formatElapsed(ms);
  const total = Math.max(0, Math.floor(ms / 60_000));
  if (total < 1) return "<1m";
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}
