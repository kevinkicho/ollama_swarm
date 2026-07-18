import { memo, useState } from "react";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  type ResolvedPrompt,
  type ResolvedThinking,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";

export interface BuildResultEnvelope {
  ok: boolean;
  exitCode?: number;
  summary: string;
}

/**
 * Compact bubble for worker build / bash command results:
 * `{ ok, exitCode, summary }` (120b2044 unformatted pretty-JSON dumps).
 */
export const BuildResultBubble = memo(function BuildResultBubble({
  result,
  header,
  className,
  style,
  thinking,
  prompt,
  toolTrace,
}: {
  result: BuildResultEnvelope;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);

  const tone = result.ok
    ? "border-emerald-800/50 bg-emerald-950/20 text-emerald-200"
    : "border-rose-800/50 bg-rose-950/20 text-rose-200";
  const badge = result.ok
    ? "bg-emerald-900/50 text-emerald-300 border-emerald-800/50"
    : "bg-rose-900/50 text-rose-300 border-rose-800/50";

  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1">{header}</div>
        <BubbleToggleRow
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
          showThinking={showThinking}
          showPrompt={showPrompt}
          showToolTrace={showToolTrace}
          onToggleThinking={() => setShowThinking((v) => !v)}
          onTogglePrompt={() => setShowPrompt((v) => !v)}
          onToggleToolTrace={() => setShowToolTrace((v) => !v)}
        />
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
      <div className={`rounded-md border px-2.5 py-2 text-[12px] ${tone}`}>
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          <span
            className={`inline-block px-1.5 py-px rounded border text-[10px] uppercase tracking-wide font-semibold ${badge}`}
          >
            {result.ok ? "ok" : "failed"}
          </span>
          {result.exitCode !== undefined ? (
            <span className="font-mono text-[10px] text-ink-400">exit {result.exitCode}</span>
          ) : null}
          <span className="text-[10px] uppercase tracking-wide text-ink-500">build result</span>
        </div>
        <div className="text-ink-100 leading-snug whitespace-pre-wrap break-words">{result.summary}</div>
      </div>
    </div>
  );
});

/** Detect `{ ok, exitCode?, summary }` build/tool envelopes for transcript UI. */
export function tryParseBuildResult(raw: string): BuildResultEnvelope | null {
  const t = raw.trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    const m = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.ok !== "boolean") return null;
  // Avoid stealing contract/hunks envelopes that also have unrelated keys.
  if (Array.isArray(o.hunks) || Array.isArray(o.criteria) || Array.isArray(o.todos)) return null;
  if (typeof o.summary !== "string" && typeof o.exitCode !== "number") return null;
  return {
    ok: o.ok,
    exitCode: typeof o.exitCode === "number" ? o.exitCode : undefined,
    summary:
      typeof o.summary === "string"
        ? o.summary
        : o.ok
          ? "Command succeeded"
          : "Command failed",
  };
}
