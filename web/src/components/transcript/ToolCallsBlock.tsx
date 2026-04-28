// Task #229 (2026-04-27 evening): collapsed-by-default renderer for
// an agent's XML pseudo-tool-call markers (<read>, <grep>, <list>,
// <glob>, <edit>, <bash>).
//
// Server-side appendAgent runs shared/extractToolCallMarkers on every
// agent response and stashes the joined markers in
// TranscriptEntry.toolCalls. MessageBubble renders THIS block above
// the entry's main bubble (next to ThoughtsBlock) when toolCalls is
// non-empty.
//
// Why surface them at all instead of just dropping them: the markers
// are the model's INTENT — what it thought it was reading/searching/
// editing. A planner that "read" 30 files mentally arrived at its
// contract for a reason; the user can audit that reasoning by
// expanding this block. Dropping silently makes debugging the planner
// much harder when its output looks wrong.

import { useState } from "react";

const MAX_OPEN_HEIGHT_PX = 300;

export function ToolCallsBlock({ markers }: { markers: string[] }) {
  const [open, setOpen] = useState(false);
  const n = markers.length;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded border border-amber-700/40 bg-amber-950/15 text-xs mb-1.5"
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-amber-400/80 hover:text-amber-200 flex items-center gap-2 list-none">
        <span aria-hidden="true">{open ? "▼" : "▶"}</span>
        <span>🔧 {n} pseudo-tool-call{n === 1 ? "" : "s"} (model emitted as text)</span>
        <span className="ml-auto text-ink-600 italic">
          {open ? "click to collapse" : "click to expand"}
        </span>
      </summary>
      <div
        className="px-3 py-2 border-t border-amber-700/40 overflow-y-auto font-mono text-amber-300/80"
        style={{ maxHeight: `${MAX_OPEN_HEIGHT_PX}px` }}
      >
        {markers.map((m, i) => (
          <div key={i} className="whitespace-pre-wrap break-all py-0.5">
            <span className="text-ink-600 mr-2">{i + 1}.</span>
            {m}
          </div>
        ))}
      </div>
    </details>
  );
}
