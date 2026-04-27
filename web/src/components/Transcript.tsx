import { useEffect, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import { StreamingDock } from "./transcript/StreamingDock";
import { MessageBubble } from "./transcript/MessageBubble";

export function Transcript() {
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Task #73: sticky-bottom auto-scroll only when the user is AT
  // the bottom. When they scroll up to read history, freeze the
  // viewport (don't yank them back) and surface a floating "↓ Latest"
  // button that takes them back to the bottom + re-enables sticky.
  const [stickyBottom, setStickyBottom] = useState(true);

  const streamingCount = Object.keys(streaming).length;
  const streamingMeta = useSwarm((s) => s.streamingMeta);

  // Task #176 Phase A: 30s safety sweeper — if a streaming entry
  // is "done" but no transcript_append has cleared it, force-clear
  // so the bubble doesn't persist forever on a runner that crashed
  // mid-finalize. clearStreaming is the canonical removal path.
  const clearStreaming = useSwarm((s) => s.clearStreaming);
  useEffect(() => {
    const stuck = Object.entries(streamingMeta).filter(
      ([, m]) => m.status === "done" && m.endedAt && Date.now() - m.endedAt > 30_000,
    );
    if (stuck.length === 0) return;
    for (const [id] of stuck) clearStreaming(id);
  }, [streamingMeta, clearStreaming]);

  // Auto-scroll only when the user hasn't intentionally scrolled up.
  useEffect(() => {
    if (!stickyBottom) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, streamingCount, stickyBottom]);

  // Track scroll position to flip sticky-bottom on/off. 80px buffer
  // so a tiny rendering shimmy doesn't accidentally drop sticky.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    if (atBottom !== stickyBottom) setStickyBottom(atBottom);
  };

  const jumpToLatest = () => {
    setStickyBottom(true);
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="h-full relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto p-4 space-y-3 bg-ink-900"
      >
        {transcript.length === 0 && streamingCount === 0 ? (
          <div className="text-ink-400 text-sm">Waiting for agents…</div>
        ) : null}
        {transcript.map((e) => (
          <MessageBubble key={e.id} entry={e} />
        ))}
        {/* Task #173: per-agent streaming dock with collapse-by-default
            + smooth fade-out on completion. Replaces the previous
            "render N inline bubbles, snap-disappear on end" pattern. */}
        <StreamingDock
          streaming={streaming}
          streamingMeta={streamingMeta}
          agents={agents}
        />
        <div ref={endRef} />
      </div>
      {!stickyBottom ? (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className="absolute bottom-4 right-4 z-10 px-3 py-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-black/50 flex items-center gap-1 transition"
        >
          <span>↓</span>
          <span>Latest</span>
        </button>
      ) : null}
    </div>
  );
}

