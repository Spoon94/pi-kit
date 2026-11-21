import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 从文件尾按字节读 ≤maxBytes，取末 lines 行；不整读大文件。 */
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
    if (len < size) parts.shift();               // 丢弃可能被截断的首行
    while (parts.length && parts.at(-1) === "") parts.pop();
    return parts.slice(-lines);
  } catch { return []; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}
