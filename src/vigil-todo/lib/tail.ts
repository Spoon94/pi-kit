import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Read ≤maxBytes from the file end by bytes and take the last `lines` lines; never read large files whole. */
export function tailLines(path: string, lines: number, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    const parts = text.split("\n");
    if (len < size) parts.shift();               // drop the possibly truncated first line
    while (parts.length && parts.at(-1) === "") parts.pop();
    return parts.slice(-lines);
  } catch { return []; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}
