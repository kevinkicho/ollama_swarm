import { useEffect, useMemo, useState } from "react";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import { useSegmentSplitterWithPoints } from "../useSegmentSplitter";
import { useSwarm } from "../../state/store";
import { MAX_BUBBLE_HEIGHT_PX } from "./JsonBubbles";
import { extractToolCallMarkers } from "../../../../shared/src/extractToolCallMarkers";

// Task #173 + #176 Phase A+B: per-agent streaming dock. Each agent
// gets a STABLE bubble that persists from first chunk through
// completion — no DOM swap on session.idle. Phase A: bubble stays
// visible after agent_streaming_end (visual transitions to ✓ +
// neutral border) until transcript_append for the same agent
// removes it via store-level dedup. Phase B: "thinking N.Ns…"
// subtitle uses lastTextAt to show the model is alive even during
// long pauses with no text emit.
export function StreamingDock({
  streaming,
  streamingMeta,
  agents,
}: {
  streaming: Record<string, string>;
  streamingMeta: Record<string, { startedAt: number; lastTextAt: number; status: "live" | "done"; endedAt?: number }>;
  agents: Record<string, { id: string; index: number }>;
}) {
  // Tick once per second so "thinking N.Ns" updates even when no
  // SSE event arrives. Cheap — only renders if dock has content.
  const [, setTickN] = useState(0);
  const ids = Object.keys(streaming);
  useEffect(() => {
    if (ids.length === 0) return;
    const t = setInterval(() => setTickN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ids.length]);

  if (ids.length === 0) return null;

  // Sort by lastTextAt descending (most recent activity first). The
  // top entry gets natural visual focus; multiple parallel agents
  // stack below it. No collapse-by-default — Phase A keeps every
  // active stream visible so the user never loses sight of any
  // agent's content.
  const ordered = ids
    .map((id) => ({
      id,
      agentIndex: agents[id]?.index ?? 0,
      text: streaming[id] ?? "",
      meta: streamingMeta[id],
    }))
    .sort((a, b) => (b.meta?.lastTextAt ?? 0) - (a.meta?.lastTextAt ?? 0));

  return (
    <div className="space-y-2">
      {ordered.map((slot) => (
        <PersistentStreamBubble
          key={`stream-${slot.id}`}
          agentId={slot.id}
          agentIndex={slot.agentIndex}
          text={slot.text}
          meta={slot.meta}
        />
      ))}
    </div>
  );
}

function PersistentStreamBubble({
  agentId,
  agentIndex,
  text,
  meta,
}: {
  agentId: string;
  agentIndex: number;
  text: string;
  meta: { startedAt: number; lastTextAt: number; status: "live" | "done"; endedAt?: number } | undefined;
}) {
  const hue = hueForAgent(agentIndex);
  const isDone = meta?.status === "done";
  const palette = agentBubblePalette(hue, isDone);
  const now = Date.now();
  const sinceLastText = meta ? Math.max(0, now - meta.lastTextAt) : 0;
  const sinceStart = meta ? Math.max(0, now - meta.startedAt) : 0;

  // 2026-04-27 evening (#231 follow-up 4): strip XML pseudo-tool-call
  // markers from the LIVE streaming text before segmenting. RCA: the
  // planner/auditor with tool grants emits dozens of <read>/<grep>
  // markers as raw text; each marker followed by \n\n triggers a Phase 2
  // content boundary, producing 100+ tiny "Segment 1: <read>..." entries
  // per turn (Kevin saw 182 segments live in run 61d59783). Stripping
  // here makes the live display readable; the marker count is surfaced
  // separately. Server-side appendAgent ALSO strips for the final
  // transcript entry, so the finalized bubble is clean too.
  const { finalText: cleanedText, toolCalls } = useMemo(
    () => extractToolCallMarkers(text),
    [text],
  );
  const { segments, splitPoints } = useSegmentSplitterWithPoints(cleanedText);
  // 2026-04-26: persist split points to the store so the finalized
  // bubble can render the same segment structure after the response
  // completes. Without this, the structure user saw live disappears.
  const setSegmentPoints = useSwarm((s) => s.setSegmentPoints);
  useEffect(() => {
    setSegmentPoints(agentId, splitPoints);
    // Use length+last as a cheap identity check — splitPoints is
    // monotonically growing, so this catches every change.
  }, [agentId, splitPoints.length, splitPoints[splitPoints.length - 1], setSegmentPoints]);

  // Subtitle changes based on activity recency:
  //   <2s since last text → "writing…"
  //   2-10s since last text → "thinking 4s…"
  //   >10s since last text → "deep reasoning 22s…" (longer pauses
  //     are usually mid-tool-call or chain-of-thought; not stuck)
  //   done → "done · X chars · Ys total · N segment(s)"
  const segCount = segments.filter((s) => s.length > 0).length;
  const segSuffix = segCount > 1 ? ` · ${segCount} segments` : "";
  let subtitle: string;
  if (isDone) {
    const totalSec = Math.round(sinceStart / 1000);
    subtitle = `done · ${text.length.toLocaleString()} chars · ${totalSec}s total${segSuffix}`;
  } else if (sinceLastText < 2000) {
    subtitle = `writing…${segSuffix}`;
  } else if (sinceLastText < 10_000) {
    subtitle = `thinking ${Math.round(sinceLastText / 1000)}s…${segSuffix}`;
  } else {
    subtitle = `deep reasoning ${Math.round(sinceLastText / 1000)}s…${segSuffix}`;
  }

  return (
    <div
      className="rounded-md p-3 border text-sm relative transition-all duration-300"
      style={{ borderColor: palette.border, background: palette.background }}
    >
      <div className="flex items-center gap-2 text-xs mb-1" style={{ color: palette.header }}>
        <span className="font-semibold">Agent {agentIndex}</span>
        <span className="text-ink-500">{subtitle}</span>
        {/* #231 follow-up 4: surface the count of stripped pseudo-tool-
            calls so the user knows the model emitted them (and they
            were filtered out of the live segment view). */}
        {toolCalls.length > 0 ? (
          <span className="text-amber-400/70 text-[10px]">
            🔧 {toolCalls.length} pseudo-tool-call{toolCalls.length === 1 ? "" : "s"} stripped
          </span>
        ) : null}
        {isDone ? (
          <span style={{ color: palette.accent }}>✓</span>
        ) : (
          <span className="inline-flex gap-0.5 items-end">
            <Dot hue={hue} delay={0} />
            <Dot hue={hue} delay={150} />
            <Dot hue={hue} delay={300} />
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {segments.slice(0, -1).map((seg, i) => (
          <CollapsedSegment key={i} index={i} text={seg} hue={hue} />
        ))}
        {segments.length > 0 ? (
          <div
            className="whitespace-pre-wrap opacity-90 overflow-y-auto"
            style={{ maxHeight: `${MAX_BUBBLE_HEIGHT_PX}px` }}
          >
            {segments[segments.length - 1] || " "}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Task #178: collapsible past-segment. Default collapsed showing
// "▸ N: first ~80 chars… (M chars)"; click to expand into a
// scrollable preformatted block. Exported 2026-04-26 so the finalized
// bubble can reuse it for the segment-preserved post-stream view.
export function CollapsedSegment({
  index,
  text,
  hue,
}: {
  index: number;
  text: string;
  hue: number;
}) {
  const [open, setOpen] = useState(false);
  const charCount = text.length.toLocaleString();
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  const palette = agentBubblePalette(hue, true);
  return (
    <div
      className="rounded border text-xs"
      style={{
        borderColor: palette.segmentBorder,
        background: palette.segmentBackground,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-black/20 transition"
        style={{ color: palette.header }}
      >
        <span className="font-mono text-[10px]">{open ? "▾" : "▸"}</span>
        <span className="font-semibold">Segment {index + 1}</span>
        <span className="text-ink-500">·</span>
        <span className="text-ink-500 flex-1 truncate" title={preview}>
          {preview}
          {text.length > 80 ? "…" : ""}
        </span>
        <span className="text-ink-500 shrink-0">{charCount} chars</span>
      </button>
      {open ? (
        <div
          className="whitespace-pre-wrap opacity-80 overflow-y-auto px-2 pb-2 text-sm"
          style={{ maxHeight: `${MAX_BUBBLE_HEIGHT_PX}px` }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function Dot({ hue, delay }: { hue: number; delay: number }) {
  const palette = agentBubblePalette(hue, false);
  return (
    <span
      className="inline-block w-1 h-1 rounded-full animate-pulse"
      style={{ background: palette.accent, animationDelay: `${delay}ms` }}
    />
  );
}
