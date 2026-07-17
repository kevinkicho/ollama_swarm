// Structured miss reports for applyHunks failures.
//
// Callers (repair prompts, council, wrap-up) need more than a free-text
// error string: kind, needle, match counts, and a nearby file excerpt so
// the next attempt can re-ground on real disk content. uniqueCandidates
// are deterministic repair anchors from findUniqueSubstrings / expandToUnique.

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
   * Deterministic unique substrings / expanded anchors for repair.
   * Filled by findUniqueSubstrings (not-found) or expandToUnique (not-unique).
   * Empty when none, or for kinds that don't produce candidates.
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

/** Min length for unique substring candidates (repair anchors need enough context). */
export const UNIQUE_CANDIDATE_MIN_LENGTH = 32;

/** Cap number of uniqueCandidates returned. */
export const UNIQUE_CANDIDATE_MAX = 5;

/** Cap each uniqueCandidates entry so repair payloads stay compact. */
export const UNIQUE_CANDIDATE_MAX_CHARS = 400;

/** Default max lines to expand above/below first match for expandToUnique. */
export const EXPAND_MAX_LINES = 5;

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

/**
 * Non-overlapping literal occurrence count (same semantics as applyHunks).
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Sparse prefix/suffix lengths for a line — avoids O(n) char-by-char probes.
 * Always includes full length and minLength when valid; plus ¾ and ½ cuts.
 */
function sparseProbeLengths(lineLen: number, minLength: number): number[] {
  if (lineLen < minLength) return [];
  const set = new Set<number>([
    lineLen,
    Math.max(minLength, Math.floor(lineLen * 0.75)),
    Math.max(minLength, Math.floor(lineLen * 0.5)),
    minLength,
  ]);
  return [...set]
    .filter((len) => len >= minLength && len <= lineLen)
    .sort((a, b) => b - a);
}

/**
 * Drop near-duplicate candidates: if A is a strict prefix/suffix of B (or
 * equal), keep only the longer/more structural one. Longest-first input order
 * preferred so multi-line / whole-line anchors win over char trims.
 */
export function diversifyCandidates(
  candidates: string[],
  max: number = UNIQUE_CANDIDATE_MAX,
): string[] {
  const sorted = [...candidates].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const kept: string[] = [];
  for (const c of sorted) {
    const redundant = kept.some(
      (k) =>
        k === c ||
        k.startsWith(c) ||
        k.endsWith(c) ||
        c.startsWith(k) ||
        c.endsWith(k),
    );
    if (redundant) continue;
    kept.push(c);
    if (kept.length >= max) break;
  }
  return kept;
}

/**
 * Shrink an oversized candidate to a unique prefix or suffix ≤ maxChars that
 * still appears exactly once in fileText. Never adds ellipsis — result is
 * always a literal substring of fileText (or null if none fits).
 */
export function fitCandidateToMax(
  candidate: string,
  fileText: string,
  maxChars: number = UNIQUE_CANDIDATE_MAX_CHARS,
  minLength: number = UNIQUE_CANDIDATE_MIN_LENGTH,
): string | null {
  if (!candidate || !fileText || maxChars < minLength) return null;
  if (candidate.length <= maxChars) {
    return countOccurrences(fileText, candidate) === 1 ? candidate : null;
  }

  // Prefer longest unique prefix ≤ maxChars, then longest unique suffix.
  for (const len of sparseProbeLengths(maxChars, minLength)) {
    const prefix = candidate.slice(0, len);
    if (countOccurrences(fileText, prefix) === 1) return prefix;
  }
  for (const len of sparseProbeLengths(maxChars, minLength)) {
    const suffix = candidate.slice(candidate.length - len);
    if (countOccurrences(fileText, suffix) === 1) return suffix;
  }
  return null;
}

/**
 * Size-cap candidates while keeping them exact unique substrings of fileText.
 * Drops entries that cannot be shortened uniquely without ellipsis.
 * Dedupes + diversifies the result.
 */
export function sizeCapCandidates(
  candidates: string[],
  fileText: string,
  maxChars: number = UNIQUE_CANDIDATE_MAX_CHARS,
  minLength: number = UNIQUE_CANDIDATE_MIN_LENGTH,
): string[] {
  const fitted: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const f = fitCandidateToMax(c, fileText, maxChars, minLength);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    fitted.push(f);
  }
  return diversifyCandidates(fitted);
}

/**
 * @deprecated Use sizeCapCandidates(candidates, fileText) — ellipsis truncation
 * produces non-literal anchors. Kept as a thin alias name only for clarity in
 * older call sites; do not use truncateForReport on candidates.
 */
export function truncateCandidates(
  candidates: string[],
  fileText: string,
  maxChars: number = UNIQUE_CANDIDATE_MAX_CHARS,
): string[] {
  return sizeCapCandidates(candidates, fileText, maxChars);
}

/**
 * Find deterministic unique substrings of `needle` that appear exactly once
 * in `fileText`. Prefers multi-line / whole-line anchors first; only falls
 * back to a sparse set of char prefixes/suffixes when still under the cap.
 * De-duplicates near-identical prefixes. Only candidates ≥ minLength.
 * Capped at UNIQUE_CANDIDATE_MAX; each entry size-capped as a literal
 * unique file substring (no ellipsis).
 *
 * Used for search_not_found / start_not_found repair suggestions — never
 * applied silently as a first-match substitute.
 */
export function findUniqueSubstrings(
  needle: string,
  fileText: string,
  minLength: number = UNIQUE_CANDIDATE_MIN_LENGTH,
): string[] {
  if (!needle || !fileText || minLength <= 0) return [];

  const seen = new Set<string>();
  const found: string[] = [];
  /** Raw bag can grow past MAX so diversify still has material for Phase 2. */
  const rawCap = UNIQUE_CANDIDATE_MAX * 3;

  const diversifiedCount = (): number =>
    diversifyCandidates(found, UNIQUE_CANDIDATE_MAX).length;

  const consider = (s: string): void => {
    if (found.length >= rawCap) return;
    if (diversifiedCount() >= UNIQUE_CANDIDATE_MAX) return;
    if (s.length < minLength) return;
    if (seen.has(s)) return;
    if (countOccurrences(fileText, s) !== 1) return;
    seen.add(s);
    found.push(s);
  };

  const lines = needle.split("\n");

  // Phase 1: multi-line / whole-line prefixes and suffixes (structural first).
  // Early-stop on *diversified* count so near-dup multi-line prefixes don't
  // skip Phase 2 before distinct lines are collected.
  for (let k = lines.length; k >= 1; k--) {
    if (diversifiedCount() >= UNIQUE_CANDIDATE_MAX) break;
    consider(lines.slice(0, k).join("\n"));
    if (k < lines.length && diversifiedCount() < UNIQUE_CANDIDATE_MAX) {
      consider(lines.slice(lines.length - k).join("\n"));
    }
  }

  // Phase 2: sparse char prefixes/suffixes only if we still need diversity.
  if (diversifiedCount() < UNIQUE_CANDIDATE_MAX) {
    for (const line of lines) {
      if (diversifiedCount() >= UNIQUE_CANDIDATE_MAX) break;
      if (line.length < minLength) continue;
      for (const len of sparseProbeLengths(line.length, minLength)) {
        if (diversifiedCount() >= UNIQUE_CANDIDATE_MAX) break;
        // Whole line already considered in phase 1.
        if (len === line.length) continue;
        consider(line.slice(0, len));
        if (diversifiedCount() >= UNIQUE_CANDIDATE_MAX) break;
        consider(line.slice(line.length - len));
      }
    }
  }

  return sizeCapCandidates(diversifyCandidates(found), fileText, UNIQUE_CANDIDATE_MAX_CHARS, minLength);
}

/**
 * When `start` matches 2+ times in `fileText`, expand by adding surrounding
 * full lines around the first match until the expanded string is unique
 * (up to maxExpandLines each side). Returns unique expanded strings as
 * repair candidates; [] if still not unique after max expansion.
 *
 * Does not apply the expansion — fail-closed multi-match still rejects.
 */
export function expandToUnique(
  start: string,
  fileText: string,
  maxExpandLines: number = EXPAND_MAX_LINES,
): string[] {
  if (!start || !fileText || maxExpandLines < 0) return [];
  if (countOccurrences(fileText, start) < 2) return [];

  const firstIdx = fileText.indexOf(start);
  if (firstIdx < 0) return [];

  const fileLines = fileText.split("\n");
  const startLine = lineIndexAtOffset(fileText, firstIdx);
  const endLine = lineIndexAtOffset(
    fileText,
    firstIdx + Math.max(start.length - 1, 0),
  );

  const seen = new Set<string>();
  const found: string[] = [];

  const considerRange = (fromLine: number, toLine: number): void => {
    if (found.length >= UNIQUE_CANDIDATE_MAX) return;
    const from = Math.max(0, fromLine);
    const to = Math.min(fileLines.length - 1, toLine);
    if (from > to) return;
    const expanded = fileLines.slice(from, to + 1).join("\n");
    if (expanded.length === 0 || seen.has(expanded)) return;
    if (countOccurrences(fileText, expanded) !== 1) return;
    seen.add(expanded);
    found.push(expanded);
  };

  // Progressive expansion: prefer smaller windows; try down-only, up-only, both.
  for (let expand = 0; expand <= maxExpandLines; expand++) {
    if (found.length >= UNIQUE_CANDIDATE_MAX) break;
    if (expand === 0) {
      // Full line(s) covering the first match (may already be unique if
      // start was a mid-line fragment of a unique line).
      considerRange(startLine, endLine);
      continue;
    }
    considerRange(startLine, endLine + expand); // down only
    considerRange(startLine - expand, endLine); // up only
    considerRange(startLine - expand, endLine + expand); // both sides
  }

  // Prefer shortest successful expansion (most specific).
  found.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return sizeCapCandidates(
    found.slice(0, UNIQUE_CANDIDATE_MAX),
    fileText,
  );
}

/**
 * Kind-primary candidate pass (no whitespace-normalize fallback).
 */
function computeUniqueCandidatesPrimary(
  kind: ApplyMissKind,
  needle: string,
  fileText: string,
): string[] {
  switch (kind) {
    case "search_not_found":
    case "start_not_found":
    case "end_not_found":
      // RR-B: endExclusive misses also get unique substring anchors for repair.
      return findUniqueSubstrings(needle, fileText);
    case "search_not_unique":
    case "start_not_unique": {
      const expanded = expandToUnique(needle, fileText);
      if (expanded.length > 0) return expanded;
      return findUniqueSubstrings(needle, fileText);
    }
    default:
      return [];
  }
}

/**
 * Compute uniqueCandidates for a miss kind. not-found → substrings of needle;
 * not-unique → expand first match; fall back to substrings if expand empty.
 *
 * When the primary pass is empty, retries with normalizeSearchWhitespace(needle)
 * so whitespace/CRLF drift that became *_not_found (normalized multi-match is
 * not auto-applied) still yields expand/substring repair anchors.
 */
export function computeUniqueCandidates(
  kind: ApplyMissKind,
  needle: string,
  fileText: string,
): string[] {
  if (
    kind !== "search_not_found" &&
    kind !== "start_not_found" &&
    kind !== "end_not_found" &&
    kind !== "search_not_unique" &&
    kind !== "start_not_unique"
  ) {
    return [];
  }

  const primary = computeUniqueCandidatesPrimary(kind, needle, fileText);
  if (primary.length > 0) return primary;

  const normalized = normalizeSearchWhitespace(needle);
  if (!normalized || normalized === needle) return primary;

  const normCount = countOccurrences(fileText, normalized);
  if (normCount >= 2) {
    const expanded = expandToUnique(normalized, fileText);
    if (expanded.length > 0) return expanded;
  }
  // count 0 or 1 (or expand empty): unique substrings of normalized needle
  return findUniqueSubstrings(normalized, fileText);
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
  /**
   * Optional override for uniqueCandidates. When omitted, computed from
   * kind + needle + fileText via computeUniqueCandidates.
   */
  uniqueCandidates?: string[];
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

  // Always size-cap against fileText so overrides and computed paths alike
  // remain exact unique substrings (no ellipsis).
  const uniqueCandidates = sizeCapCandidates(
    input.uniqueCandidates ??
      computeUniqueCandidates(input.kind, input.needle, input.fileText),
    input.fileText,
  );

  return {
    file: input.file,
    hunkIndex: input.hunkIndex,
    op: input.op,
    kind: input.kind,
    needle: truncateForReport(input.needle),
    matchCount: input.matchCount,
    nearbyExcerpt: buildNearbyExcerpt(input.fileText, { focusOffset: focus }),
    uniqueCandidates,
    message: input.message,
  };
}
