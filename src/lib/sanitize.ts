const LINE_SEP = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
const BIDI = new RegExp(
  "[" + String.fromCharCode(0x200e, 0x200f) + String.fromCharCode(0x202a) + "-"
  + String.fromCharCode(0x202e, 0x2066) + "-" + String.fromCharCode(0x2069) + "]", "g");

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
    .replace(/\u001b./g, "")
    .replace(LINE_SEP, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : ""))
    .replace(BIDI, "");
}

/** 逐行清洗，保留换行分隔（用于多行终端输出/工具文本/唤醒消息）。 */
export function sanitizeMultiline(value: string): string {
  return value.split("\n").map(sanitizeTerminalText).join("\n");
}

