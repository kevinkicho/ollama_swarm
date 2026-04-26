import { useEffect, useRef, useState } from "react";

// Task #178: gap threshold (ms) above which a new burst of text is
// treated as a NEW segment — earlier text gets checkpointed into a
// collapsible. 5s catches "deep reasoning" pauses without splitting
// on the normal sub-second SSE-chunk cadence.
export const SEGMENT_PAUSE_MS = 5000;

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
    // threshold, the prev.text.length boundary becomes a split point.
    const gap = Date.now() - prev.lastTextChangeAt;
    if (gap >= pauseMs && prev.text.length > 0) {
      setSplitPoints((sp) =>
        sp.length > 0 && sp[sp.length - 1] === prev.text.length ? sp : [...sp, prev.text.length],
      );
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
