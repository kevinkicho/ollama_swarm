import { memo, useMemo, useState } from "react";
import { AgentJsonBubble, MAX_BUBBLE_HEIGHT_PX } from "./JsonBubbles";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  type ResolvedPrompt,
  type ResolvedThinking,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";
// Task #74 (2026-04-25): readable diff renderer for worker_hunks.
// Soft-parse + replace_between/write live in shared tryParseWorkerHunks
// (2010479c: raw JSON bubbles when client parse only knew replace/create/append).
import {
  tryParseWorkerEnvelope,
  tryParseWorkerHunks as parseSharedWorkerHunks,
  type ParsedHunk as SharedParsedHunk,
} from "@ollama-swarm/shared/workerHunks";

export type ParsedHunk = SharedParsedHunk;
export function tryParseWorkerHunks(rawJson: string): ParsedHunk[] | null {
  return parseSharedWorkerHunks(rawJson);
}
export const WorkerHunksBubble = memo(function WorkerHunksBubble({
  summary,
  rawJson,
  header,
  className,
  style,
  thinking,
  prompt,
  toolTrace,
}: {
  summary: string;
  rawJson: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);
  // Collapsed by default so runs aren't drowned in patch/diff UI.
  const [expanded, setExpanded] = useState(false);
  const envelope = useMemo(() => tryParseWorkerEnvelope(rawJson), [rawJson]);
  // Fallback: if we can't parse, defer to AgentJsonBubble.
  if (!envelope) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={summary}
        json={rawJson}
        thinking={thinking}
        prompt={prompt}
        toolTrace={toolTrace}
      />
    );
  }

  // Git-native: working tree already updated on disk — no search/replace cards.
  if (envelope.type === "workingTree") {
    const wt = envelope.workingTree;
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
          >
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
            >
              {showRaw ? "Hide JSON" : "View JSON"}
            </button>
          </BubbleToggleRow>
        </div>
        {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
        {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
        {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded font-semibold bg-emerald-900/40 text-emerald-300">
            git working tree
          </span>
          <span className="text-ink-200">{summary}</span>
        </div>
        {wt.files.length > 0 ? (
          <ul className="mt-1.5 text-[11px] font-mono text-ink-400 space-y-0.5">
            {wt.files.slice(0, 12).map((f) => (
              <li key={f}>· {f}</li>
            ))}
            {wt.files.length > 12 ? (
              <li className="text-ink-500">… +{wt.files.length - 12} more</li>
            ) : null}
          </ul>
        ) : null}
        {showRaw ? (
          <pre
            className="mt-2 text-[11px] font-mono text-ink-300 whitespace-pre-wrap break-all rounded border border-ink-700 bg-ink-950 p-2 overflow-y-auto"
            style={{ maxHeight: MAX_BUBBLE_HEIGHT_PX }}
          >
            {rawJson}
          </pre>
        ) : null}
      </div>
    );
  }

  const hunks = envelope.hunks;
  // Per-bubble +/- totals — sum across hunks. Right-aligned next to
  // the summary line so the bubble's at-a-glance change footprint
  // matches the per-hunk badges below.
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    const c = countHunkLines(h);
    added += c.added;
    removed += c.removed;
  }
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
        >
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
          >
            {expanded ? "Hide diff" : `Show diff (${hunks.length} hunk${hunks.length === 1 ? "" : "s"})`}
          </button>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
          >
            {showRaw ? "Hide raw" : "Raw JSON"}
          </button>
        </BubbleToggleRow>
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
      <div className="flex items-baseline gap-2 mb-2 text-[11px]">
        <div className="text-ink-400 flex-1 min-w-0 truncate">{summary}</div>
        {added > 0 ? <div className="text-emerald-300 font-mono tabular-nums shrink-0">+{added}</div> : null}
        {removed > 0 ? <div className="text-rose-300 font-mono tabular-nums shrink-0">−{removed}</div> : null}
      </div>
      {expanded ? (
        <div className="space-y-2 overflow-y-auto" style={{ maxHeight: `${MAX_BUBBLE_HEIGHT_PX * 2}px` }}>
          {hunks.map((h, i) => (
            <HunkBlock key={i} hunk={h} index={i} />
          ))}
        </div>
      ) : null}
      {showRaw ? (
        <div className="mt-2 rounded border border-ink-700 bg-ink-950 p-2">
          <pre className="text-[10px] font-mono text-ink-300 whitespace-pre-wrap break-all">
            {rawJson}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
const HunkBlock = memo(function HunkBlock({ hunk: h, index }: { hunk: ParsedHunk; index: number }) {
  const opColor =
    h.op === "replace" || h.op === "replace_between"
      ? "text-amber-300"
      : h.op === "create" || h.op === "write"
        ? "text-emerald-300"
        : h.op === "delete"
          ? "text-rose-300"
          : "text-sky-300";
  const counts = countHunkLines(h);
  return (
    <div className="rounded border border-ink-700 overflow-hidden">
      <div className="bg-ink-800/60 px-2 py-1 flex items-baseline gap-2 text-[11px] font-mono">
        <span className="text-ink-500">#{index + 1}</span>
        <span className={`uppercase font-semibold ${opColor}`}>{h.op}</span>
        <span className="text-ink-300 break-all flex-1 min-w-0 truncate" title={h.file}>{h.file}</span>
        {counts.added > 0 ? (
          <span className="text-emerald-300 tabular-nums shrink-0">+{counts.added}</span>
        ) : null}
        {counts.removed > 0 ? (
          <span className="text-rose-300 tabular-nums shrink-0">−{counts.removed}</span>
        ) : null}
      </div>
      {h.op === "replace" ? (
        <>
          <DiffPane label="− search" text={h.search ?? ""} accent="bg-rose-950/40 border-rose-900/40 text-rose-200" />
          <DiffPane label="+ replace" text={h.replace ?? ""} accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200" />
        </>
      ) : h.op === "replace_between" ? (
        <>
          <DiffPane label="start" text={h.start ?? ""} accent="bg-ink-900/60 border-ink-700 text-ink-300" />
          {h.endExclusive ? (
            <DiffPane label="endExclusive" text={h.endExclusive} accent="bg-ink-900/60 border-ink-700 text-ink-300" />
          ) : (
            <div className="border-t border-ink-700 px-2 py-0.5 text-[10px] text-ink-500">endExclusive: EOF</div>
          )}
          <DiffPane label="+ replace" text={h.replace ?? ""} accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200" />
        </>
      ) : h.op === "delete" ? (
        <div className="border-t border-ink-700 px-2 py-1 text-[11px] text-rose-300">delete file</div>
      ) : (
        <DiffPane
          label={h.op === "create" ? "+ new file" : h.op === "write" ? "+ write" : "+ append"}
          text={h.content ?? ""}
          accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200"
        />
      )}
    </div>
  );
});

// Count line-equivalents in a hunk's text. Mirrors the server-side
// countNewlines() so the UI's +N/-M badges match the per-agent
// linesAdded/Removed totals server-side. Trailing-newline-tolerant.
function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}
function countHunkLines(h: ParsedHunk): { added: number; removed: number } {
  if (h.op === "replace") {
    return { added: countLines(h.replace ?? ""), removed: countLines(h.search ?? "") };
  }
  if (h.op === "replace_between") {
    return { added: countLines(h.replace ?? ""), removed: 0 };
  }
  if (h.op === "delete") {
    return { added: 0, removed: 0 };
  }
  return { added: countLines(h.content ?? ""), removed: 0 };
}
const DiffPane = memo(function DiffPane({ label, text, accent }: { label: string; text: string; accent: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_LINES = 12;
  const lines = text.split("\n");
  const showAll = expanded || lines.length <= PREVIEW_LINES;
  const shown = showAll ? text : lines.slice(0, PREVIEW_LINES).join("\n") + `\n…  (${lines.length - PREVIEW_LINES} more lines)`;
  return (
    <div className={`border-t border-ink-700 ${accent}`}>
      <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <pre className="px-2 pb-1 text-[11px] font-mono whitespace-pre-wrap break-all">{shown}</pre>
      {!showAll ? (
        <button
          onClick={() => setExpanded(true)}
          className="text-[10px] underline px-2 pb-1 opacity-80 hover:opacity-100"
        >
          show all {lines.length} lines
        </button>
      ) : null}
    </div>
  );
});
