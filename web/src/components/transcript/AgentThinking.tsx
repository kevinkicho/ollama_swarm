import { memo, useMemo, useState, type ReactNode } from "react";
import type { TranscriptEntry } from "../../types";
import { extractThinkTags } from "../../../../shared/src/extractThinkTags";
import { stripAgentText } from "../../../../shared/src/stripAgentText";
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
  if (entry.text.includes("<think>") || entry.text.includes("</think>")) {
    const { thoughts } = extractThinkTags(entry.text);
    if (thoughts.trim()) {
      return { text: thoughts.trim(), source: "thoughts" };
    }
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

/** Visible bubble body — strips inline think tags for legacy entries missing entry.thoughts. */
export function resolveAgentDisplayText(entry: TranscriptEntry): string {
  if (entry.thoughts?.trim()) return entry.text;
  if (!entry.text.includes("<think>") && !entry.text.includes("</think>")) {
    return entry.text;
  }
  const { finalText } = stripAgentText(entry.text);
  return finalText.length > 0 ? finalText : entry.text;
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

export type ResolvedPrompt = {
  text: string;
  label?: string;
};

export type ResolvedToolTraceEntry = {
  tool: string;
  ok: boolean;
  preview: string;
  ts?: number;
};

export function resolveEntryToolTrace(
  entry: TranscriptEntry,
): ResolvedToolTraceEntry[] | null {
  const trace = entry.toolTrace;
  if (!trace?.length) return null;
  return trace;
}

export function toolTraceToggleLabel(trace: ResolvedToolTraceEntry[], open: boolean): string {
  if (open) return "Hide tools";
  const errors = trace.filter((t) => !t.ok).length;
  const suffix = errors > 0 ? `, ${errors} err` : "";
  return `Tools (${trace.length}${suffix})`;
}

export const ToolTraceToggleButton = memo(function ToolTraceToggleButton({
  trace,
  open,
  onClick,
}: {
  trace: ResolvedToolTraceEntry[];
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
      title="SDK tool invocations during this turn (read, list, web_search, …)"
    >
      {toolTraceToggleLabel(trace, open)}
    </button>
  );
});

export const ToolTraceContentPanel = memo(function ToolTraceContentPanel({
  trace,
}: {
  trace: ResolvedToolTraceEntry[];
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  return (
    <div className="mt-2 rounded border border-cyan-900/60 bg-cyan-950/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-cyan-300/80 mb-1">
        Tool invocations · {trace.length}
      </div>
      <ul className="space-y-1 text-[11px] font-mono max-h-96 overflow-y-auto">
        {trace.map((row, i) => {
          const open = expandedIdx === i;
          const chipCls = row.ok
            ? "text-cyan-300 bg-cyan-950/50 border-cyan-800/50"
            : "text-rose-300 bg-rose-950/40 border-rose-800/50";
          return (
            <li key={i} className="rounded border border-ink-800/60 bg-ink-950/30 px-2 py-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`shrink-0 uppercase tracking-wider text-[9px] px-1 rounded border ${chipCls}`}>
                  {row.tool}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-400" title={row.preview || undefined}>
                  {row.ok ? "ok" : "error"}: {row.preview.trim() || "(no preview)"}
                </span>
                {row.preview.length > 60 ? (
                  <button
                    type="button"
                    onClick={() => setExpandedIdx(open ? null : i)}
                    className="shrink-0 text-[9px] uppercase tracking-wide text-ink-500 hover:text-ink-300"
                  >
                    {open ? "Hide" : "Preview"}
                  </button>
                ) : null}
              </div>
              {open && row.preview ? (
                <div className="mt-1 text-[10px] text-ink-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                  {row.preview}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

export function resolveEntryPrompt(entry: TranscriptEntry): ResolvedPrompt | null {
  const text = entry.promptText?.trim();
  if (!text) return null;
  const label = entry.promptLabel?.trim();
  return { text, ...(label ? { label } : {}) };
}

export function promptToggleLabel(prompt: ResolvedPrompt, open: boolean): string {
  if (open) return "Hide prompt";
  const chars = prompt.text.length.toLocaleString();
  return `Prompt (${chars} chars)`;
}

export const PromptToggleButton = memo(function PromptToggleButton({
  prompt,
  open,
  onClick,
}: {
  prompt: ResolvedPrompt;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
      title={
        prompt.label
          ? `Outbound prompt for this turn (${prompt.label})`
          : "Outbound prompt sent to this agent for this turn"
      }
    >
      {promptToggleLabel(prompt, open)}
    </button>
  );
});

export const PromptContentPanel = memo(function PromptContentPanel({
  prompt,
}: {
  prompt: ResolvedPrompt;
}) {
  const caption = prompt.label
    ? `${prompt.label} · ${prompt.text.length.toLocaleString()} chars`
    : `Outbound prompt · ${prompt.text.length.toLocaleString()} chars`;
  const tooLong = prompt.text.length > 8000;
  const [expanded, setExpanded] = useState(false);
  const shown =
    !tooLong || expanded ? prompt.text : prompt.text.slice(0, 8000).trimEnd() + "…";
  return (
    <div className="mt-2 rounded border border-cyan-900/60 bg-cyan-950/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-cyan-300/80 mb-1">
        {caption}
      </div>
      <div className="whitespace-pre-wrap opacity-80 text-[11px] max-h-96 overflow-y-auto leading-relaxed font-mono">
        {shown}
      </div>
      {tooLong ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
        >
          {expanded ? "Show less" : `Show more (${(prompt.text.length - 8000).toLocaleString()} chars)`}
        </button>
      ) : null}
    </div>
  );
});

/** Top-right toggle row shared by agent bubbles (thinking + prompt + tools + extras). */
export const BubbleToggleRow = memo(function BubbleToggleRow({
  thinking,
  prompt,
  toolTrace,
  showThinking,
  showPrompt,
  showToolTrace,
  onToggleThinking,
  onTogglePrompt,
  onToggleToolTrace,
  children,
}: {
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
  showThinking: boolean;
  showPrompt: boolean;
  showToolTrace?: boolean;
  onToggleThinking: () => void;
  onTogglePrompt: () => void;
  onToggleToolTrace?: () => void;
  children?: ReactNode;
}) {
  if (!thinking && !prompt && !toolTrace?.length && !children) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0 justify-end">
      {prompt ? (
        <PromptToggleButton prompt={prompt} open={showPrompt} onClick={onTogglePrompt} />
      ) : null}
      {toolTrace && toolTrace.length > 0 && onToggleToolTrace ? (
        <ToolTraceToggleButton
          trace={toolTrace}
          open={!!showToolTrace}
          onClick={onToggleToolTrace}
        />
      ) : null}
      {thinking ? (
        <ThinkingToggleButton
          thinking={thinking}
          open={showThinking}
          onClick={onToggleThinking}
        />
      ) : null}
      {children}
    </div>
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