import { useState } from "react";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import type { TranscriptEntry } from "../../types";
import { useSwarm } from "../../state/store";

/**
 * Renders an agent-stream transcript entry — the thinking text that was
 * visible while the agent was producing its final response. Collapsed
 * by default; click to expand and see the full thinking text.
 */
export function StreamingTranscriptCard({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(false);
  const agents = useSwarm((s) => s.agents);
  const meta = entry.streamingMeta;
  const agentIndex =
    entry.agentIndex ??
    (entry.agentId ? agents[entry.agentId]?.index : undefined) ??
    0;
  const hue = hueForAgent(agentIndex);
  const palette = agentBubblePalette(hue, false);

  return (
    <div
      className="rounded-md border p-2 text-xs"
      style={{ borderColor: palette.border, background: palette.background }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left flex items-center gap-2"
      >
        <span className="text-ink-500">{expanded ? "▾" : "▸"}</span>
        <span style={{ color: palette.header }} className="font-semibold">
          Agent {agentIndex} — thinking
        </span>
        <span className="text-ink-500 text-[11px]">
          {meta?.totalSeconds ?? "?"}s · {entry.text.length.toLocaleString()} chars
        </span>
        {meta?.toolCallCount ? (
          <span className="text-amber-400/70 text-[10px]">
            {meta.toolCallCount} pseudo-tool-call{meta.toolCallCount === 1 ? "" : "s"} stripped
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="mt-2 whitespace-pre-wrap text-[11px] opacity-80 overflow-y-auto max-h-[300px] font-mono">
          {entry.text}
        </div>
      ) : null}
    </div>
  );
}
