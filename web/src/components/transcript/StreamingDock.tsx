import { useEffect, useMemo, useState } from "react";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import { useSwarm } from "../../state/store";
import { ProgressTimeline } from "./ProgressTimeline";
import {
  streamDisplayParts,
  streamDoneSubtitle,
  streamLiveSubtitle,
} from "./streamDisplayMetrics";

// Task #173 + #176 Phase A+B: per-agent streaming dock. Each agent
// gets a STABLE bubble that persists from first chunk through
// completion (animations removed from transcript area).
export function StreamingDock({
  streaming,
  streamingMeta,
  agents,
}: {
  streaming: Record<string, string>;
  streamingMeta: Record<string, { startedAt: number; lastTextAt: number; status: "live" | "done"; endedAt?: number }>;
  agents: Record<string, { id: string; index: number }>;
}) {
  // Tick once per second so live "thinking Ns…" subtitles update even
  // when no SSE event arrives. Stop ticking once every slot is "done"
  // so frozen totals (endedAt − startedAt) don't keep climbing.
  const [, setTickN] = useState(0);
  const ids = Object.keys(streaming);
  const hasLive = useMemo(
    () => ids.some((id) => streamingMeta[id]?.status === "live"),
    [ids, streamingMeta],
  );
  useEffect(() => {
    if (ids.length === 0 || !hasLive) return;
    const t = setInterval(() => setTickN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ids.length, hasLive]);

  if (ids.length === 0) return null;

  // Sort by stable agentIndex (ascending) so bubbles keep a fixed
  // visual position. Pre-fix: sort by lastTextAt descending caused
  // bubbles to swap positions on every chunk arrival as different
  // agents took turns being "most recent" — visually a violent flash
  // where adjacent bubbles traded slots multiple times per second.
  // Stable sort by agentIndex eliminates the swap entirely; the
  // user's eye learns "agent-1 is always at top" and stops fighting
  // for focus.
  const ordered = ids
    .map((id) => ({
      id,
      agentIndex: agents[id]?.index ?? 0,
      text: streaming[id] ?? "",
      meta: streamingMeta[id],
    }))
    .sort((a, b) => a.agentIndex - b.agentIndex);

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
  const isBrain = agentIndex === 0;
  const isDone = meta?.status === "done";
  const now = Date.now();
  const sinceLastText = meta ? Math.max(0, now - meta.lastTextAt) : 0;
  const STALL_THRESHOLD_MS = 60_000;
  const isStalled = !isDone && sinceLastText > STALL_THRESHOLD_MS;

  const palette = agentBubblePalette(hue, isStalled ? true : isDone, isBrain);
  const glowClass = ""; // animations removed from transcript

  // 2026-04-27 evening (#231 follow-up 4): strip XML pseudo-tool-call
  // markers from the LIVE streaming text before segmenting. RCA: the
  // planner/auditor with tool grants emits dozens of <read>/<grep>
  // markers as raw text; each marker followed by \n\n triggers a Phase 2
  // content boundary, producing 100+ tiny "Segment 1: <read>..." entries
  // per turn (Kevin saw 182 segments live in run 61d59783). Stripping
  // here makes the live display readable; the marker count is surfaced
  // separately. Server-side appendAgent ALSO strips for the final
  // transcript entry, so the finalized bubble is clean too.
  //
  // Also strip think tags (extractThinkTags) client-side so the segment
  // splitter computes split points on text that matches what the server
  // will finalize (stripAgentText runs both extractors). Without this,
  // split points are offset from the final text, causing bracket-junk
  // rendering like "[]" in the finalized bubble.
  const parts = useMemo(() => streamDisplayParts(text), [text]);
  const { finalText: cleanedText, toolCalls, outputChars, thinkingChars } = parts;
  const timelineText =
    cleanedText.length > 0
      ? cleanedText
      : thinkingChars > 0
        ? "(reasoning in progress — output not started yet)"
        : "";

  // Detect if the model is looping (same text repeating)
  const isLooping = useMemo(() => {
    if (text.length < 200) return false;
    // Check for repeated identical blocks
    const lines = text.split('\n').filter(Boolean);
    if (lines.length < 3) return false;
    const last3 = lines.slice(-3);
    if (last3[0] === last3[1] && last3[1] === last3[2]) return true;
    // Check for repeated suffix
    for (let rLen = 20; rLen <= Math.min(200, text.length / 3); rLen++) {
      const tail = text.slice(-rLen);
      let count = 0, pos = text.length;
      while (pos >= rLen && text.slice(pos - rLen, pos) === tail) { count++; pos -= rLen; }
      if (count >= 3) return true;
    }
    return false;
  }, [text]);

  // Subtitle changes based on activity recency:
  //   <2s since last text → "writing…"
  //   2-10s since last text → "thinking 4s…"
  //   >10s since last text → "deep reasoning 22s…" (longer pauses
  //     are usually mid-tool-call or chain-of-thought; not stuck)
  //   done → "done · X chars · Ys total"
  let subtitle: string;
  if (isLooping) {
    subtitle = `⚠ looping (${toolCalls.length} pseudo-tool-calls)`;
  } else if (isDone) {
    const endAt = meta?.endedAt ?? meta?.lastTextAt ?? now;
    const totalSec = Math.round(Math.max(0, endAt - (meta?.startedAt ?? endAt)) / 1000);
    subtitle = streamDoneSubtitle(parts, totalSec);
  } else {
    subtitle = streamLiveSubtitle(parts, sinceLastText, isStalled);
  }

  return (
    <div
      className="rounded-md p-3 border text-sm relative"
      style={{ borderColor: palette.border, background: palette.background }}
    >
      <div className="flex items-center gap-2 text-xs mb-1" style={{ color: palette.header }}>
        <span className="font-semibold">{isBrain ? "🧠 Brain" : `Agent ${agentIndex}`}</span>
        <span className="text-ink-500">{subtitle}</span>
        {/* #231 follow-up 4: surface the count of stripped pseudo-tool-
            calls so the user knows the model emitted them (and they
            were filtered out of the live segment view). */}
        {thinkingChars > 0 ? (
          <span className="text-indigo-400/70 text-[10px]" title="Chain-of-thought stripped from output char count">
            💭 {thinkingChars.toLocaleString()} thinking stripped
          </span>
        ) : null}
        {toolCalls.length > 0 ? (
          <span className="text-amber-400/70 text-[10px]">
            🔧 {toolCalls.length} pseudo-tool-call{toolCalls.length === 1 ? "" : "s"} stripped
          </span>
        ) : null}
        {isDone ? (
          <span style={{ color: palette.accent }}>✓</span>
        ) : isStalled ? (
          <span className="text-ink-500" title="No chunks received for over 60s">⚠</span>
        ) : (
          <span className="inline-flex gap-0.5 items-end">
            <Dot hue={hue} delay={0} />
            <Dot hue={hue} delay={150} />
            <Dot hue={hue} delay={300} />
          </span>
        )}
      </div>
      <ProgressTimeline text={timelineText} className="max-h-48 overflow-y-auto" />
    </div>
  );
}

function Dot({ hue, delay }: { hue: number; delay: number }) {
  const palette = agentBubblePalette(hue, false);
  return (
    <span
      className="inline-block w-1 h-1 rounded-full"
      style={{ background: palette.accent }}
    />
  );
}
