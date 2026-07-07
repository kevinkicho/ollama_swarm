// Phase 1 (UI coherent-fix package, 2026-04-27): collapsed-by-default
// renderer for an agent's <think>...</think> reasoning content.
//
// The server-side appendAgent runs shared/extractThinkTags on every
// agent response and stashes the joined thoughts in
// TranscriptEntry.thoughts (separately from the visible final text).
// Legacy standalone block — agent bubbles now render thinking inside
// the bubble via AgentThinking.tsx (Show thinking toggle). Kept for
// reference / gallery reuse if needed.
//
// Design choices:
//  - <details>/<summary> instead of useState — native browser
//    support, keyboard a11y, no React state to track.
//  - Muted gray border + ink-900 bg so it's visually distinct from
//    the agent's actual response (which carries the agent's hue).
//  - Char count in the summary label gives a quick "how much
//    thinking happened" signal without expanding.
//  - Max-height on the open content prevents a 50KB thought from
//    pushing the rest of the transcript way down.

import { memo, useState } from "react";

const MAX_OPEN_HEIGHT_PX = 400;

export const ThoughtsBlock = memo(function ThoughtsBlock({ text }: { text: string }) {
  // useState mirroring the <details> open attribute — lets the
  // summary label react to the toggle (e.g. "expand" vs "collapse").
  const [open, setOpen] = useState(false);
  const charCount = text.length;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded border border-ink-700/60 bg-ink-900/40 text-xs mb-1.5"
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-ink-400 hover:text-ink-200 flex items-center gap-2 list-none">
        <span aria-hidden="true">{open ? "▼" : "▶"}</span>
        <span>💭 thinking · {charCount.toLocaleString()} chars</span>
      </summary>
      <div
        className="px-3 py-2 border-t border-ink-700/60 whitespace-pre-wrap text-ink-300 overflow-y-auto"
        style={{ maxHeight: `${MAX_OPEN_HEIGHT_PX}px` }}
      >
        {text}
      </div>
    </details>
  );
});
