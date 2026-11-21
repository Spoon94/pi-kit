import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { FpVerdict } from "../board/types.js";
import type { JobStore } from "../jobs/store.js";
import type { Job } from "../jobs/types.js";

/** HEAD + tracked 工作区状态哈希；非 git 或失败返回 undefined（已知盲区：ignored 文件不计）。 */
export function collectFingerprint(cwd: string): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return createHash("sha1").update(head.trim()).update("\n").update(status).digest("hex").slice(0, 12);
  } catch { return undefined; }
}

const overlaps = (a: Job, b: Job): boolean =>
  a.id !== b.id && a.cwd === b.cwd && a.taskId !== b.taskId
  && b.startedAt <= (a.endedAt ?? Number.MAX_SAFE_INTEGER)
  && (b.endedAt ?? Number.MAX_SAFE_INTEGER) >= a.startedAt;

/** 两集合必须分开：有写入 vs 无法判定（规格 §5.2）。 */
export function classifyOverlap(job: Job, store: JobStore) {
  const interferers: string[] = [];
  const overlapUnfinished: string[] = [];
  for (const other of store.all()) {
    if (!overlaps(job, other)) continue;
    if (other.fpEnd === undefined) overlapUnfinished.push(other.id);
    else if (other.fpStart !== other.fpEnd) interferers.push(other.id);
  }
  return { interferers, overlapUnfinished };
}

/** 回填时才计算；两集合皆空且指纹变了才 stale。 */
export function verdictAt(job: Job, store: JobStore): FpVerdict {
  if (job.fpStart === undefined || job.fpEnd === undefined) return "unknown";
  if (job.fpStart === job.fpEnd) return "fresh";
  const { interferers, overlapUnfinished } = classifyOverlap(job, store);
  return interferers.length === 0 && overlapUnfinished.length === 0 ? "stale" : "unknown";
}

export function fpReason(job: Job): string {
  if (job.fpVerdict === "fresh") return "fp:fresh";
  if (job.fpVerdict === "stale") return "fp:stale（独占期间工作区变过）";
  if (job.overlapUnfinished.length > 0) return `fp:unknown（${job.overlapUnfinished.join(",")} 无法判定：未结束/结果未知）`;
  if (job.interferers.length > 0) return `fp:unknown（${job.interferers.join(",")} 期间有写入，无法归因）`;
  if (job.fpStart !== undefined && job.fpEnd !== undefined && job.fpStart !== job.fpEnd) return "fp:unknown（无法归因）";
  return "fp:n/a（非 git 或采集失败）";
}
