// Worker prompt size control.
//
// Background (phase11c-medium-v5): the worker user prompt dumps the full
// contents of every expectedFile so the model has enough context to produce
// a diff. A 49KB README (common in non-trivial repos) pushes the prompt past
// 50KB. Combined with Ollama cloud response-generation latency this blew
// past undici's 5-min header timeout on every README-touching todo (c2
// unmet, see summary.json for that run).
//
// Fix: show a head+tail window of any file above a threshold, with a marker
// in the middle that tells the worker the omitted range exists. Workers
// need to see the file's beginning (headings, imports, top-of-file anchors)
// and end (last section, EOF anchors for "append"). Middle edits are less
// common on large files, and when they do come up the worker can still
// succeed by using an anchor that's visible in the head or tail — the
// replace hunk schema enforces exact-single-match so ambiguity fails closed.

// Threshold and head/tail sizes chosen to land a 49KB README under 8KB of
// worker prompt. Head + tail + marker is always ≤ threshold, so crossing
// the threshold always strictly shrinks the prompt.
export const WORKER_FILE_WINDOW_THRESHOLD = 16_000;
export const WORKER_FILE_HEAD_BYTES = 6_000;
export const WORKER_FILE_TAIL_BYTES = 6_000;

export interface WindowedFileView {
  // true when the worker receives the whole file verbatim.
  full: boolean;
  // What to embed in the prompt. On `full=false`, includes the gap marker.
  content: string;
  // Original file size, so the worker prompt can show "49123 chars total"
  // and the model understands what it's not seeing.
  originalLength: number;
}

// Pure function. Deterministic, no I/O, trivially testable.
export function windowFileForWorker(content: string): WindowedFileView {
  const len = content.length;
  if (len <= WORKER_FILE_WINDOW_THRESHOLD) {
    return { full: true, content, originalLength: len };
  }

  const head = content.slice(0, WORKER_FILE_HEAD_BYTES);
  const tail = content.slice(len - WORKER_FILE_TAIL_BYTES);
  const omitted = len - WORKER_FILE_HEAD_BYTES - WORKER_FILE_TAIL_BYTES;

  // Marker is prose so a human reading the prompt transcript understands
  // the view; it also reminds the model that the file is larger than what's
  // shown and suggests anchors that will work.
  const marker =
    `\n\n... [${omitted} chars omitted — file is ${len} chars total. ` +
    `To edit text in the omitted region, use op "append" for end-of-file ` +
    `additions, or use op "replace" with a "search" anchor that is unique ` +
    `and visible in the head or tail shown above/below.] ...\n\n`;

  return { full: false, content: head + marker + tail, originalLength: len };
}

// Unit 44b: lines of context to grab around each anchor match.
// 25 lines on each side ≈ 1-2 KB per anchor for typical markdown/code,
// fits comfortably in the worker prompt budget alongside the head+tail
// fallback. Whole-row markdown table edits are the primary motivation.
export const WORKER_ANCHOR_LINES_BEFORE = 25;
export const WORKER_ANCHOR_LINES_AFTER = 25;

export interface AnchorReport {
  anchor: string;
  /** 1-based line of the primary match (first unique, or first of multi). */
  found: number | null;
  /** Total non-overlapping occurrences in the file. */
  matchCount: number;
  /** All 1-based match lines when matchCount > 1 (capped). */
  matchLines?: number[];
}

export interface AnchoredFileView extends WindowedFileView {
  // Per-anchor outcome, in input order. Multi-match anchors list all line
  // numbers and include first+last context bands so panelRegistry-style
  // repeated titles don't silently window only the first hit.
  anchorReports: AnchorReport[];
}

/** Cap multi-match line listings in the prompt. */
export const ANCHOR_MULTI_MATCH_LINES_CAP = 12;

// Unit 44b: when the planner declared anchor strings for a todo, expand
// the windowed view to include a context band around each anchor. The
// head + tail are still included (so global anchors keep working), and
// each found anchor contributes a line-range excerpt with surrounding
// context. Misses are reported honestly so the model knows the row it
// was told to edit isn't actually in the file.
//
// Pure function: no I/O, deterministic given (content, anchors).
//
// Behavior:
// - If `anchors` is empty, returns the same shape as windowFileForWorker
//   (with anchorReports: []).
// - If the file is small (under threshold), returns full content but
//   still reports per-anchor found-or-not so the planner gets feedback.
// - If the file is large, returns head + per-anchor excerpts + tail,
//   with overlapping or near-duplicate ranges merged.
/** All non-overlapping 0-based char offsets of `needle` in `content`. */
export function findAllMatchOffsets(content: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const i = content.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + Math.max(1, needle.length);
    if (out.length >= 50) break;
  }
  return out;
}

export function lineNumberAtOffset(content: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, content.length);
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function windowFileWithAnchors(
  content: string,
  anchors: readonly string[],
): AnchoredFileView {
  const baseAnchors = anchors.map((a) => a.trim()).filter((a) => a.length > 0);
  const len = content.length;

  // Locate every match (not first-only). Multi-match anchors get all line #s
  // and first+last context bands (RR-B panelRegistry-style repeated titles).
  const reports: AnchorReport[] = baseAnchors.map((anchor) => {
    const offsets = findAllMatchOffsets(content, anchor);
    if (offsets.length === 0) {
      return { anchor, found: null, matchCount: 0 };
    }
    const matchLines = offsets.map((o) => lineNumberAtOffset(content, o));
    return {
      anchor,
      found: matchLines[0]!,
      matchCount: offsets.length,
      ...(offsets.length > 1
        ? { matchLines: matchLines.slice(0, ANCHOR_MULTI_MATCH_LINES_CAP) }
        : {}),
    };
  });

  if (baseAnchors.length === 0 || len <= WORKER_FILE_WINDOW_THRESHOLD) {
    const base = windowFileForWorker(content);
    return { ...base, anchorReports: reports };
  }

  // Build per-anchor excerpts (1-based line ranges), merge overlaps.
  // Multi-match: window first AND last hit so workers see both sections.
  const lines = content.split("\n");
  const ranges: Array<{ from: number; to: number; anchor: string; multiNote?: string }> = [];
  for (const r of reports) {
    if (r.found === null) continue;
    const lineNums =
      r.matchLines && r.matchLines.length > 0
        ? r.matchLines
        : [r.found];
    const uniqueLines = [...new Set(lineNums)];
    // For multi-match, keep first + last only (avoid N× windows).
    const focusLines =
      uniqueLines.length <= 1
        ? uniqueLines
        : [uniqueLines[0]!, uniqueLines[uniqueLines.length - 1]!];
    for (const ln of focusLines) {
      const from = Math.max(1, ln - WORKER_ANCHOR_LINES_BEFORE);
      const to = Math.min(lines.length, ln + WORKER_ANCHOR_LINES_AFTER);
      ranges.push({
        from,
        to,
        anchor: r.anchor,
        multiNote:
          r.matchCount > 1
            ? `multi-match×${r.matchCount} at lines ${lineNums.slice(0, ANCHOR_MULTI_MATCH_LINES_CAP).join(", ")}${lineNums.length > ANCHOR_MULTI_MATCH_LINES_CAP ? "…" : ""} — use unique surrounding context`
            : undefined,
      });
    }
  }
  // Sort + merge overlapping/adjacent ranges so the prompt doesn't
  // duplicate lines when two anchors land in the same neighborhood.
  ranges.sort((a, b) => a.from - b.from);
  const merged: Array<{
    from: number;
    to: number;
    anchors: string[];
    multiNotes: string[];
  }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
      last.anchors.push(r.anchor);
      if (r.multiNote) last.multiNotes.push(r.multiNote);
    } else {
      merged.push({
        from: r.from,
        to: r.to,
        anchors: [r.anchor],
        multiNotes: r.multiNote ? [r.multiNote] : [],
      });
    }
  }

  // Compose: head + each excerpt (with marker headers) + tail.
  const head = content.slice(0, WORKER_FILE_HEAD_BYTES);
  const tail = content.slice(len - WORKER_FILE_TAIL_BYTES);

  const sections: string[] = [head];
  if (merged.length === 0) {
    // All anchors missed → fall back to plain windowed view marker.
    const omitted = len - WORKER_FILE_HEAD_BYTES - WORKER_FILE_TAIL_BYTES;
    sections.push(
      `\n\n... [${omitted} chars omitted — none of the declared anchors were ` +
        `found in this file. The anchor strings the planner declared do not ` +
        `appear verbatim. Use op "replace" with a "search" anchor that IS ` +
        `visible in the head or tail shown above/below.] ...\n\n`,
    );
  } else {
    for (const m of merged) {
      const anchorLabel = m.anchors.length === 1
        ? `anchor "${shortAnchor(m.anchors[0]!)}"`
        : `anchors ${m.anchors.map((a) => `"${shortAnchor(a)}"`).join(", ")}`;
      const multiBit =
        m.multiNotes.length > 0
          ? ` WARNING: ${[...new Set(m.multiNotes)].join("; ")}`
          : "";
      const excerpt = lines.slice(m.from - 1, m.to).join("\n");
      sections.push(
        `\n\n... [ANCHORED EXCERPT, lines ${m.from}-${m.to} of ${lines.length}, around ${anchorLabel}${multiBit}] ...\n\n${excerpt}\n\n... [end excerpt] ...\n\n`,
      );
    }
  }
  sections.push(tail);

  return {
    full: false,
    content: sections.join(""),
    originalLength: len,
    anchorReports: reports,
  };
}

// Truncate an anchor string for display in the excerpt header so a long
// anchor doesn't blow up the prompt with its own quotation.
function shortAnchor(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}
