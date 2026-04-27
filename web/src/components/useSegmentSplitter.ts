import { useEffect, useRef, useState } from "react";

// Task #178: gap threshold (ms) above which a new burst of text is
// treated as a NEW segment — earlier text gets checkpointed into a
// collapsible. 5s catches "deep reasoning" pauses without splitting
// on the normal sub-second SSE-chunk cadence.
export const SEGMENT_PAUSE_MS = 5000;
// 2026-04-26 fix: minimum chars a segment must contain to be
// checkpointed. Without this, models that emit single-char delimiters
// (newline, whitespace) between reasoning phases create useless 1-char
// segments. glm-5.1 in deep-reasoning mode reproduces this exactly:
// real chunk → 5s pause → "\n" → 5s pause → real chunk → repeat.
const MIN_SEGMENT_CHARS = 20;

// Task #188: extracted from PersistentStreamBubble. Tracks the cumulative
// text and splits it into segments wherever a >= pauseMs gap appeared
// between successive growths. Returns the segment slices in order; last
// element is always the active (in-progress) segment.
//
// Resets segment state when the input text shrinks or restarts (i.e. a
// new prompt cycle reuses the same bubble). Caller owns the lifecycle of
// the underlying agent — this hook is a pure transformer of `text`.
export function useSegmentSplitter(text: string, pauseMs: number = SEGMENT_PAUSE_MS): string[] {
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
    // Text grew. If the gap since last change crosses the pause
    // threshold AND the segment that would end at this boundary has
    // meaningful content (>=MIN_SEGMENT_CHARS since the last split),
    // the prev.text.length boundary becomes a split point.
    const gap = Date.now() - prev.lastTextChangeAt;
    if (gap >= pauseMs && prev.text.length > 0) {
      setSplitPoints((sp) => {
        const lastSplit = sp.length > 0 ? sp[sp.length - 1] : 0;
        const candidateSplit = prev.text.length;
        // Skip if exactly the same boundary as last (idempotency).
        if (sp.length > 0 && sp[sp.length - 1] === candidateSplit) return sp;
        // Skip if the segment from lastSplit to candidateSplit would be
        // tiny — the model just emitted a delimiter, not a real thought.
        // Let the next real chunk extend the prior segment instead.
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
  return segments;
}
