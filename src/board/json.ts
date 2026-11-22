/** 保守的 JSON 值校验：无环、深度 ≤64、节点 ≤10000、仅有限数字/JSON 类型。 */
const MAX_NODES = 10_000;
const MAX_DEPTH = 64;

export function isJsonSafe(value: unknown): boolean {
  let nodes = 0;
  const seen = new Set<object>();
  const stack: { v: unknown; d: number }[] = [{ v: value, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (++nodes > MAX_NODES) return false;
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return false; continue; }
    if (typeof v !== "object") return false;
    if (d >= MAX_DEPTH) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, d: d + 1 });
      continue;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const x of Object.values(v)) stack.push({ v: x, d: d + 1 });
  }
  return true;
}

const VERIFY_MAX = 4096;

/** verify 规格：kind=command、非空、≤4096、无 NUL；换行允许（shell 脚本）。 */
export function verifyError(v: { kind?: unknown; command?: unknown }): string | undefined {
  if (v.kind !== "command") return `verify.kind must be "command"`;
  if (typeof v.command !== "string" || v.command.trim() === "") return "verify.command required (non-empty)";
  if (v.command.length > VERIFY_MAX) return `verify.command too long (max ${VERIFY_MAX})`;
  if (v.command.includes("\u0000")) return "verify.command contains NUL";
  return undefined;
}
