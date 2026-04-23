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
export const WORKER_FILE_WINDOW_THRESHOLD = 8_000;
export const WORKER_FILE_HEAD_BYTES = 3_000;
export const WORKER_FILE_TAIL_BYTES = 3_000;

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

export interface AnchoredFileView extends WindowedFileView {
  // Per-anchor outcome, in input order. `found` is the first match's
  // 1-based line. `excerpt` is the lines included (or null when missing).
  // Lets the prompt builder report misses honestly so the model doesn't
  // hallucinate a row that isn't there.
  anchorReports: Array<{ anchor: string; found: number | null }>;
}

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
export function windowFileWithAnchors(
  content: string,
  anchors: readonly string[],
): AnchoredFileView {
  const baseAnchors = anchors.map((a) => a.trim()).filter((a) => a.length > 0);
  const len = content.length;

  // Locate each anchor (first occurrence only — anchors should be unique
  // by planner contract; ambiguous ones still resolve to the first hit
  // so the worker has SOMETHING to look at).
  const reports: AnchoredFileView["anchorReports"] = baseAnchors.map((anchor) => {
    const idx = content.indexOf(anchor);
    if (idx < 0) return { anchor, found: null };
    // 1-based line number of the match (count newlines in [0, idx)).
    let line = 1;
    for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++;
    return { anchor, found: line };
  });

  if (baseAnchors.length === 0 || len <= WORKER_FILE_WINDOW_THRESHOLD) {
    const base = windowFileForWorker(content);
    return { ...base, anchorReports: reports };
  }

  // Build per-anchor excerpts (1-based line ranges), merge overlaps.
  const lines = content.split("\n");
  const ranges: Array<{ from: number; to: number; anchor: string }> = [];
  for (const r of reports) {
    if (r.found === null) continue;
    const from = Math.max(1, r.found - WORKER_ANCHOR_LINES_BEFORE);
    const to = Math.min(lines.length, r.found + WORKER_ANCHOR_LINES_AFTER);
    ranges.push({ from, to, anchor: r.anchor });
  }
  // Sort + merge overlapping/adjacent ranges so the prompt doesn't
  // duplicate lines when two anchors land in the same neighborhood.
  ranges.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number; anchors: string[] }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
      last.anchors.push(r.anchor);
    } else {
      merged.push({ from: r.from, to: r.to, anchors: [r.anchor] });
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
      const excerpt = lines.slice(m.from - 1, m.to).join("\n");
      sections.push(
        `\n\n... [ANCHORED EXCERPT, lines ${m.from}-${m.to} of ${lines.length}, around ${anchorLabel}] ...\n\n${excerpt}\n\n... [end excerpt] ...\n\n`,
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
