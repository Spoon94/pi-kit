import { chainJobs } from "./chain.js";
import type { JobStore } from "./store.js";

export function requestKill(store: JobStore, idOrRoot: string, by: "self" | "external", now: number) {
  const target = store.get(idOrRoot);
  if (!target) return { killed: [] as string[], cancelledBackoff: [] as string[] };
  const list = chainJobs(store, target.rootId);
  const killed: string[] = [];
  const cancelledBackoff: string[] = [];
  for (const j of list) {
    const next = { ...j, kill: { requestedBy: by, at: now } };
    if (next.retryAt != null) { delete next.retryAt; cancelledBackoff.push(j.id); }
    if (j.status === "running") killed.push(j.id);
    store.put(next);
  }
  return { killed, cancelledBackoff };
}

/** Synchronous force-kill: process group first; used on exceptional paths such as failed post-spawn bookkeeping (B3). */
export function killNow(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); return; } catch { /* no process group */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

/** SIGTERM → wait timeoutMs → SIGKILL; process group first. */
export async function escalate(pid: number, timeoutMs: number): Promise<void> {
  const send = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); return; } catch { /* no process group */ }
    try { process.kill(pid, sig); } catch { /* already exited */ }
  };
  send("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  send("SIGKILL");
}
