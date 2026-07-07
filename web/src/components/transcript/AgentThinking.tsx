import { memo, useMemo } from "react";
import type { TranscriptEntry } from "../../types";
import { parseThinkingDisplay } from "../../../../shared/src/parseThinkingDisplay";
import { tryPrettyJson } from "./JsonBubbles";

export type ResolvedThinking = {
  text: string;
  seconds?: number;
  source: "thoughts" | "stream";
};

/** Prefer server-stripped think tags; fall back to folded stream snapshot when it differs from final text. */
export function resolveEntryThinking(entry: TranscriptEntry): ResolvedThinking | null {
  if (entry.thoughts?.trim()) {
    return { text: entry.thoughts.trim(), source: "thoughts" };
  }
  const snap = entry.streamSnapshot;
  if (!snap?.text.trim()) return null;
  const finalNorm = tryPrettyJson(entry.text) ?? entry.text.trim();
  const snapNorm = tryPrettyJson(snap.text) ?? snap.text.trim();
  if (snapNorm === finalNorm || snap.text.trim() === entry.text.trim()) return null;
  return {
    text: snap.text,
    seconds: snap.streamingMeta?.totalSeconds,
    source: "stream",
  };
}

export function thinkingToggleLabel(
  thinking: ResolvedThinking,
  open: boolean,
): string {
  if (open) return "Hide thinking";
  if (thinking.source === "stream" && thinking.seconds != null) {
    return `Thinking (${thinking.seconds}s)`;
  }
  return `Thinking (${thinking.text.length.toLocaleString()} chars)`;
}

export const ThinkingToggleButton = memo(function ThinkingToggleButton({
  thinking,
  open,
  onClick,
}: {
  thinking: ResolvedThinking;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
      title={
        thinking.source === "stream"
          ? "Raw streamed text visible while the agent was still generating"
          : "Chain-of-thought reasoning stripped from the final response"
      }
    >
      {thinkingToggleLabel(thinking, open)}
    </button>
  );
});

export const ThinkingContentPanel = memo(function ThinkingContentPanel({
  thinking,
}: {
  thinking: ResolvedThinking;
}) {
  const parsed = useMemo(() => parseThinkingDisplay(thinking.text), [thinking.text]);
  const caption =
    thinking.source === "stream"
      ? `Streamed while generating · ${thinking.text.length.toLocaleString()} chars`
      : `Reasoning · ${thinking.text.length.toLocaleString()} chars`;
  return (
    <div className="mt-2 rounded border border-indigo-900/60 bg-indigo-950/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-indigo-300/80 mb-1">
        {caption}
      </div>
      {parsed.intents.length > 0 ? (
        <details className="mb-2 rounded border border-amber-800/40 bg-amber-950/20 text-[11px]">
          <summary className="cursor-pointer select-none px-2 py-1 text-amber-300/90 hover:text-amber-100 list-none">
            Intended tool calls ({parsed.intents.length})
          </summary>
          <ul className="px-2 pb-2 space-y-0.5 text-amber-200/90 font-mono">
            {parsed.intents.map((intent, i) => (
              <li key={i} className="break-all">
                <span className="text-amber-400">{intent.name}</span>
                {intent.detail ? (
                  <span className="text-ink-300"> → {intent.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="whitespace-pre-wrap opacity-80 text-[11px] max-h-96 overflow-y-auto leading-relaxed">
        {parsed.prose || (parsed.intents.length > 0 ? "(reasoning was only pseudo-tool XML)" : thinking.text)}
      </div>
    </div>
  );
});