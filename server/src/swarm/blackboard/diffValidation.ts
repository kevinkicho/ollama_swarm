// Runner-side safety checks that run after parsing but before writing.
// Kept pure + synchronous so they are trivially testable.

export interface Diff {
  file: string;
  newText: string;
}

// Return the paths where the worker would replace a previously non-empty
// file with an empty string. We block this at the runner because a single
// model hallucination ("output nothing") would otherwise delete code that
// passed CAS. Deliberately creating an empty file (old absent or old empty)
// stays allowed.
export function findZeroedFiles(
  diffs: readonly Diff[],
  oldContents: Readonly<Record<string, string | null>>,
): string[] {
  const out: string[] = [];
  for (const d of diffs) {
    if (d.newText.length !== 0) continue;
    const old = oldContents[d.file];
    if (typeof old === "string" && old.length > 0) out.push(d.file);
  }
  return out;
}

// Return the paths where newText begins with a UTF-8 BOM (U+FEFF). Some
// models emit a leading BOM when asked for the "full contents" of a file;
// writing it through breaks tooling silently — git diffs look empty, node
// module parsers choke, linters report phantom errors. Reject at the gate.
export function findBomPrefixed(diffs: readonly Diff[]): string[] {
  const out: string[] = [];
  for (const d of diffs) {
    if (d.newText.charCodeAt(0) === 0xfeff) out.push(d.file);
  }
  return out;
}
