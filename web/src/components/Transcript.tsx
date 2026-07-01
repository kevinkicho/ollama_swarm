import { useEffect, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import { StreamingDock } from "./transcript/StreamingDock";
import { MessageBubble } from "./transcript/MessageBubble";
import { StreamingTranscriptCard } from "./transcript/StreamingTranscriptCard";

export function Transcript() {
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickyBottom, setStickyBottom] = useState(true);
  const [filter, setFilter] = useState<"all" | "system" | "agents" | "audit" | "issues">("all");

  const streamingCount = Object.keys(streaming).length;
  const streamingMeta = useSwarm((s) => s.streamingMeta);

  // Per-agent streaming timeout
  const clearStreaming = useSwarm((s) => s.clearStreaming);
  const STREAMING_TIMEOUT_MS = 90_000;
  useEffect(() => {
    const stuck = Object.entries(streamingMeta).filter(
      ([, m]) => {
        if (m.status === "live" && Date.now() - m.lastTextAt > STREAMING_TIMEOUT_MS) return true;
        if (m.status === "done" && m.endedAt && Date.now() - m.endedAt > STREAMING_TIMEOUT_MS) return true;
        return false;
      },
    );
    if (stuck.length === 0) return;
    for (const [id] of stuck) clearStreaming(id);
  }, [streamingMeta, clearStreaming]);

  // Auto-scroll only when the user hasn't intentionally scrolled up.
  useEffect(() => {
    if (!stickyBottom) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, streamingCount, stickyBottom]);

  // Track scroll position to flip sticky-bottom on/off.
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

  // Filter transcript entries
  const filteredTranscript = transcript.filter((e) => {
    if (filter === "all") return true;
    if (filter === "system") return e.role === "system";
    if (filter === "agents") return e.role === "agent" || e.role === "agent-stream";
    if (filter === "audit") {
      const text = e.text || "";
      return text.includes("audit") || text.includes("Audit") || text.includes("Gate");
    }
    if (filter === "issues") {
      const text = e.text || "";
      return text.includes("CONTRADICTION") || text.includes("PARTIAL") || text.includes("error") || text.includes("failed");
    }
    return true;
  });

  return (
    <div className="h-full relative">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-ink-800/50 border-b border-ink-700/50">
        <span className="text-[10px] text-ink-500">Filter:</span>
        {(["all", "system", "agents", "audit", "issues"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              filter === f
                ? "bg-ink-600 text-ink-200"
                : "text-ink-400 hover:text-ink-200 hover:bg-ink-700"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="text-[10px] text-ink-500 ml-auto">
          {filteredTranscript.length} / {transcript.length} entries
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto p-4 space-y-3 bg-ink-900"
      >
        {filteredTranscript.length === 0 && streamingCount === 0 ? (
          <div className="text-ink-400 text-sm">Waiting for agents…</div>
        ) : null}
        {filteredTranscript.map((e) => (
          e.role === "agent-stream" ? (
            <StreamingTranscriptCard key={e.id} entry={e} />
          ) : (
            <MessageBubble key={e.id} entry={e} />
          )
        ))}
        {/* Inline streaming entries — show as MessageBubble-style entries */}
        {Object.entries(streaming).map(([agentId, text]) => {
          if (!text || text.length === 0) return null;
          const meta = streamingMeta[agentId];
          const elapsed = meta ? ((Date.now() - meta.startedAt) / 1000).toFixed(1) : "?";
          return (
            <div key={`streaming-${agentId}`} className="flex items-start gap-2 px-2 py-1 rounded bg-ink-800/50 border border-ink-700/50 animate-pulse">
              <span className="text-[10px] font-mono text-ink-400 shrink-0 mt-0.5">
                {agentId}
              </span>
              <span className="text-[10px] text-ink-500 shrink-0">thinking {elapsed}s…</span>
              <span className="text-xs text-ink-300 truncate flex-1">{text.slice(-200)}</span>
            </div>
          );
        })}
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

