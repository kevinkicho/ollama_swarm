// Structured miss reports for applyHunks failures.
//
// Callers (repair prompts, council, wrap-up) need more than a free-text
// error string: kind, needle, match counts, and a nearby file excerpt so
// the next attempt can re-ground on real disk content. uniqueCandidates
// is reserved for PR2 (findUniqueSubstrings / expandToUnique).

export type ApplyMissKind =
  | "search_not_found"
  | "search_not_unique"
  | "start_not_found"
  | "start_not_unique"
  | "end_not_found"
  | "other";

export interface ApplyMissReport {
  file: string;
  hunkIndex: number;
  op: string;
  kind: ApplyMissKind;
  /** Snippet model used (truncated). */
  needle: string;
  matchCount: number;
  /** ±N lines around best guess / first match / file head. */
  nearbyExcerpt: string;
  /**
   * Deterministic unique substrings of needle that appear once in file.
   * Empty in PR1; filled by PR2 findUniqueSubstrings / expandToUnique.
   */
  uniqueCandidates: string[];
  /** Human one-liner for transcript (compatible with today's messages). */
  message: string;
}

/** Lines above/below the focus line for nearbyExcerpt. */
export const NEARBY_LINE_RADIUS = 5;

/** Cap nearbyExcerpt size (~800–1500 char band). */
export const NEARBY_EXCERPT_MAX_CHARS = 1200;

/** Cap needle field so reports stay compact in transcripts. */
export const NEEDLE_REPORT_MAX_CHARS = 200;

/**
 * Trailing-whitespace / CRLF normalize used by replace search fuzzy fallback.
 * Split on `\n`, trimEnd each line (drops trailing spaces and leftover `\r`),
 * rejoin. Identity when already clean.
 */
export function normalizeSearchWhitespace(s: string): string {
  return s.split("\n").map((l) => l.trimEnd()).join("\n");
}

export function truncateForReport(
  s: string,
  maxChars: number = NEEDLE_REPORT_MAX_CHARS,
): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return "…";
  return s.slice(0, maxChars - 1) + "…";
}

/**
 * Map a character offset to a 0-based line index (newline-separated).
 */
export function lineIndexAtOffset(fileText: string, offset: number): number {
  if (offset <= 0) return 0;
  let line = 0;
  const end = Math.min(offset, fileText.length);
  for (let i = 0; i < end; i++) {
    if (fileText.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Build ±radius lines around a character offset, or file head when focus
 * is missing / not found. Truncates to maxChars.
 */
export function buildNearbyExcerpt(
  fileText: string,
  options?: {
    /** Character offset of best-guess anchor (e.g. first match). null/undefined → file head. */
    focusOffset?: number | null;
    radius?: number;
    maxChars?: number;
  },
): string {
  if (!fileText) return "";
  const radius = options?.radius ?? NEARBY_LINE_RADIUS;
  const maxChars = options?.maxChars ?? NEARBY_EXCERPT_MAX_CHARS;
  const lines = fileText.split("\n");
  const focus = options?.focusOffset;

  let start: number;
  let end: number;
  if (focus == null || focus < 0) {
    // File head: first (2*radius+1) lines (~11 with default radius).
    start = 0;
    end = Math.min(lines.length, 2 * radius + 1);
  } else {
    const center = lineIndexAtOffset(fileText, focus);
    start = Math.max(0, center - radius);
    end = Math.min(lines.length, center + radius + 1);
  }

  let excerpt = lines.slice(start, end).join("\n");
  if (excerpt.length > maxChars) {
    excerpt = truncateForReport(excerpt, maxChars);
  }
  return excerpt;
}

export interface BuildApplyMissReportInput {
  file: string;
  hunkIndex: number;
  op: string;
  kind: ApplyMissKind;
  needle: string;
  matchCount: number;
  fileText: string;
  message: string;
  /**
   * Character offset for nearby excerpt. When undefined:
   * - if matchCount > 0 and needle is non-empty, first indexOf(needle)
   * - else file head
   */
  focusOffset?: number | null;
}

export function buildApplyMissReport(
  input: BuildApplyMissReportInput,
): ApplyMissReport {
  let focus = input.focusOffset;
  if (focus === undefined) {
    if (input.needle.length > 0 && input.matchCount > 0) {
      const idx = input.fileText.indexOf(input.needle);
      focus = idx >= 0 ? idx : null;
    } else {
      focus = null;
    }
  }

  return {
    file: input.file,
    hunkIndex: input.hunkIndex,
    op: input.op,
    kind: input.kind,
    needle: truncateForReport(input.needle),
    matchCount: input.matchCount,
    nearbyExcerpt: buildNearbyExcerpt(input.fileText, { focusOffset: focus }),
    uniqueCandidates: [],
    message: input.message,
  };
}
