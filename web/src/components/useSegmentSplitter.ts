import { useEffect, useRef, useState } from "react";

// Task #178: gap threshold (ms) above which a new burst of text is
// treated as a NEW segment — earlier text gets checkpointed into a
// collapsible. 5s caught "deep reasoning" pauses on glm-5.1 SSE.
//
// 2026-04-27 (UI Phase 2): bumped 5s → 15s as a FALLBACK only.
// Pause-detection is fragile: chunk timing varies wildly by model,
// provider, and upstream load (V2 OllamaClient direct path delivers
// in 1-2 big batches → no pauses → 0 segments → live bubble shows
// nothing). Primary segmentation now happens via CONTENT BOUNDARIES
// (`\n\n`, code-fence, markdown headers, <think> tags). Pause
// fallback only fires for very-rapid contiguous text without natural
// breaks — exactly the scenario where pause-based was working pre-V2.
export const SEGMENT_PAUSE_MS = 15_000;
// 2026-04-26 fix: minimum chars a segment must contain to be
// checkpointed. Without this, models that emit single-char delimiters
// (newline, whitespace) between reasoning phases create useless 1-char
// segments. glm-5.1 in deep-reasoning mode reproduces this exactly:
// real chunk → 5s pause → "\n" → 5s pause → real chunk → repeat.
const MIN_SEGMENT_CHARS = 20;

// Phase 2: content-boundary detector. Returns the split points (offsets
// into the FULL text where a new segment should begin) found in the
// portion of `text` newly added since `prevLen`. Boundaries detected:
//   - "\n\n" (paragraph break) → split AFTER the second \n
//   - "```" (code-fence open or close) → split AFTER the fence
//   - "\n# " / "\n## " / "\n### " / "\n#### " (markdown header) → split BEFORE the #
//   - "<think>" / "</think>" → split AT the tag (so the rendered
//     segments naturally separate think content from final response;
//     paired with Phase 1's server-side <think> stripping)
function findContentBoundaries(text: string, prevLen: number): number[] {
  const boundaries: number[] = [];
  if (prevLen >= text.length) return boundaries;
  const appended = text.slice(prevLen);

  // \n\n boundaries — split AFTER each
  let idx = 0;
  while ((idx = appended.indexOf("\n\n", idx)) !== -1) {
    boundaries.push(prevLen + idx + 2);
    idx += 2;
  }
  // ``` code-fence boundaries — split AFTER each
  let fenceIdx = 0;
  while ((fenceIdx = appended.indexOf("```", fenceIdx)) !== -1) {
    boundaries.push(prevLen + fenceIdx + 3);
    fenceIdx += 3;
  }
  // markdown header boundaries — split BEFORE the # so the header
  // starts a new segment cleanly. Match \n followed by 1-4 #s + space.
  const headerRe = /\n(#{1,4}) /g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(appended)) !== null) {
    boundaries.push(prevLen + m.index + 1);
  }
  // <think> / </think> tag boundaries — at the tag itself
  let thinkOpen = 0;
  while ((thinkOpen = appended.indexOf("<think>", thinkOpen)) !== -1) {
    boundaries.push(prevLen + thinkOpen);
    thinkOpen += 7;
  }
  let thinkClose = 0;
  while ((thinkClose = appended.indexOf("</think>", thinkClose)) !== -1) {
    boundaries.push(prevLen + thinkClose + 8);
    thinkClose += 8;
  }

  // Dedupe + sort.
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

// Task #188: extracted from PersistentStreamBubble. Tracks the cumulative
// text and splits it into segments wherever a >= pauseMs gap appeared
// between successive growths. Returns the segment slices in order; last
// element is always the active (in-progress) segment.
//
// Resets segment state when the input text shrinks or restarts (i.e. a
// new prompt cycle reuses the same bubble). Caller owns the lifecycle of
// the underlying agent — this hook is a pure transformer of `text`.
//
// 2026-04-26: also returns splitPoints (the raw indices) so callers can
// persist them across the streaming-bubble → finalized-bubble transition.
// Without this, the segment structure the user sees live disappears once
// the response finalizes — visible in run b6d91d13.
export function useSegmentSplitterWithPoints(
  text: string,
  pauseMs: number = SEGMENT_PAUSE_MS,
): { segments: string[]; splitPoints: number[] } {
  const [splitPoints, setSplitPoints] = useState<number[]>([]);
  const prevTextRef = useRef<{ text: string; lastTextChangeAt: number }>({
    text: "",
    lastTextChangeAt: Date.now(),
  });

  useEffect(() => {
    const prev = prevTextRef.current;
    if (text === prev.text) return; // no change
    if (text.length < prev.text.length || !text.startsWith(prev.text)) {
      // Text shrank or restarted — reset segments (new prompt cycle).
      prevTextRef.current = { text, lastTextChangeAt: Date.now() };
      setSplitPoints([]);
      return;
    }
    // Phase 2 (UI coherent-fix, 2026-04-27): primary detection is
    // content boundaries in the newly-appended portion. Pause-based
    // is a fallback for very-rapid text without natural breaks.
    const contentSplits = findContentBoundaries(text, prev.text.length);
    setSplitPoints((sp) => {
      const lastSplit = sp.length > 0 ? sp[sp.length - 1] : 0;
      const additions: number[] = [];
      for (const candidate of contentSplits) {
        // Idempotency: skip if equals the last existing split.
        if (sp.length > 0 && sp[sp.length - 1] === candidate) continue;
        if (additions.length > 0 && additions[additions.length - 1] === candidate) continue;
        // Min-segment guard: skip if the prior segment would be tiny.
        // Use the latest split as the reference point.
        const latest = additions.length > 0 ? additions[additions.length - 1] : lastSplit;
        if (candidate - latest < MIN_SEGMENT_CHARS) continue;
        additions.push(candidate);
      }
      return additions.length > 0 ? [...sp, ...additions] : sp;
    });

    // Pause fallback: if the gap since last change crosses the pause
    // threshold AND the segment is meaningful, also mark a split at
    // the prev boundary. Catches dense single-paragraph responses
    // that pause mid-stream without natural content boundaries.
    const gap = Date.now() - prev.lastTextChangeAt;
    if (gap >= pauseMs && prev.text.length > 0) {
      setSplitPoints((sp) => {
        const lastSplit = sp.length > 0 ? sp[sp.length - 1] : 0;
        const candidateSplit = prev.text.length;
        if (sp.length > 0 && sp[sp.length - 1] === candidateSplit) return sp;
        if (candidateSplit - lastSplit < MIN_SEGMENT_CHARS) return sp;
        return [...sp, candidateSplit];
      });
    }
    prevTextRef.current = { text, lastTextChangeAt: Date.now() };
  }, [text, pauseMs]);

  const segments: string[] = [];
  let cursor = 0;
  for (const sp of splitPoints) {
    if (sp <= cursor || sp > text.length) continue;
    segments.push(text.slice(cursor, sp));
    cursor = sp;
  }
  segments.push(text.slice(cursor));
  return { segments, splitPoints };
}

// Backwards-compatible alias — returns just the segments array. Callers
// that don't need to persist splitPoints can keep using this.
export function useSegmentSplitter(text: string, pauseMs: number = SEGMENT_PAUSE_MS): string[] {
  return useSegmentSplitterWithPoints(text, pauseMs).segments;
}

// Pure helper: rebuild segments from text + persisted splitPoints. Used
// by the finalized-bubble path to render with the same segment structure
// the streaming bubble showed live.
export function segmentsFromSplitPoints(text: string, splitPoints: number[]): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const sp of splitPoints) {
    if (sp <= cursor || sp > text.length) continue;
    out.push(text.slice(cursor, sp));
    cursor = sp;
  }
  out.push(text.slice(cursor));
  return out;
}
