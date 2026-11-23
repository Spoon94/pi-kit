/** Acceptance-id parsing shared by the spec-coverage checks. */
export function extractFIds(text: string): number[] {
  return [...new Set([...text.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** Ids present in the spec text but absent from the test corpus. */
export function missingFIds(specText: string, corpusText: string): number[] {
  return extractFIds(specText).filter((n) => !new RegExp(`\\bF${n}\\b`).test(corpusText));
}