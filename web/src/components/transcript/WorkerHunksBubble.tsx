import { useMemo, useState } from "react";
import { AgentJsonBubble, MAX_BUBBLE_HEIGHT_PX } from "./JsonBubbles";
import { extractFirstBalancedJson } from "../extractJson";

// Task #74 (2026-04-25): readable diff renderer for worker_hunks
// envelopes. Parses the JSON, renders one block per hunk: op + file
// header, then search/replace as stacked code blocks (red for what
// the worker is removing, green for what it's adding). Create / append
// ops only show the green "added" block. Falls back to AgentJsonBubble
// when the JSON is malformed or doesn't contain a hunks array.
interface ParsedHunk {
  op: "replace" | "create" | "append";
  file: string;
  search?: string;
  replace?: string;
  content?: string;
}
function parseLooseJson(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  // 1. Strict parse first.
  try { return JSON.parse(s); } catch { /* fall through */ }
  // 2. ```json ... ``` fence stripping.
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  // 3. First-balanced extract — handles models that hallucinate
  //    chat-template continuation after the real response (gemma4
  //    observed in run b6d91d13 producing 17KB of fake "next prompt"
  //    cycles after a valid hunks JSON). The depth-counting extractor
  //    correctly stops at the first complete object.
  const firstBalanced = extractFirstBalancedJson(s);
  if (firstBalanced) {
    try { return JSON.parse(firstBalanced); } catch { /* fall through */ }
  }
  return undefined;
}
export function tryParseWorkerHunks(rawJson: string): ParsedHunk[] | null {
  const parsed = parseLooseJson(rawJson);
  if (typeof parsed !== "object" || parsed === null) return null;
  const hunks = (parsed as { hunks?: unknown }).hunks;
  if (!Array.isArray(hunks)) return null;
  const out: ParsedHunk[] = [];
  for (const h of hunks) {
    if (typeof h !== "object" || h === null) continue;
    const ho = h as Record<string, unknown>;
    const op = ho.op;
    const file = ho.file;
    if (typeof op !== "string" || typeof file !== "string") continue;
    if (op === "replace" && typeof ho.search === "string" && typeof ho.replace === "string") {
      out.push({ op, file, search: ho.search, replace: ho.replace });
    } else if ((op === "create" || op === "append") && typeof ho.content === "string") {
      out.push({ op, file, content: ho.content });
    }
  }
  return out.length > 0 ? out : null;
}
export function WorkerHunksBubble({
  summary,
  rawJson,
  header,
  className,
  style,
  segmentSplitPoints,
  segmentHue,
}: {
  summary: string;
  rawJson: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  segmentSplitPoints?: number[];
  segmentHue?: number;
}) {
  const [showRaw, setShowRaw] = useState(false);
  // 2026-04-27 (UI Phase 3 follow-up per Kevin): collapsed by default,
  // matching the "Posted N todos" / Contract bubble summary-then-expand
  // pattern. Pre-fix, hunks rendered inline (capped via maxHeight) and
  // every blackboard run visually drowned in diff blocks. Now: just
  // the summary line + +/- counts; "Show diff" toggles the inline render.
  const [expanded, setExpanded] = useState(false);
  const hunks = useMemo(() => tryParseWorkerHunks(rawJson), [rawJson]);
  // Fallback: if we can't parse, defer to AgentJsonBubble.
  if (!hunks) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={summary}
        json={rawJson}
        segmentSplitPoints={segmentSplitPoints}
        segmentHue={segmentHue}
      />
    );
  }
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
        <div className="flex items-center gap-2 shrink-0">
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
        </div>
      </div>
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
}
function HunkBlock({ hunk: h, index }: { hunk: ParsedHunk; index: number }) {
  const opColor = h.op === "replace" ? "text-amber-300" : h.op === "create" ? "text-emerald-300" : "text-sky-300";
  const counts = countHunkLines(h);
  return (
    <div className="rounded border border-ink-700 overflow-hidden">
      <div className="bg-ink-800/60 px-2 py-1 flex items-baseline gap-2 text-[11px] font-mono">
        <span className="text-ink-500">#{index + 1}</span>
        <span className={`uppercase font-semibold ${opColor}`}>{h.op}</span>
        <span className="text-ink-300 break-all flex-1 min-w-0 truncate" title={h.file}>{h.file}</span>
        {/* Line counters — right-aligned, hidden when 0 (per Kevin's
            review: don't show "+0" or "-0" noise). */}
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
      ) : (
        <DiffPane
          label={h.op === "create" ? "+ new file" : "+ append"}
          text={h.content ?? ""}
          accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200"
        />
      )}
    </div>
  );
}

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
  return { added: countLines(h.content ?? ""), removed: 0 };
}
function DiffPane({ label, text, accent }: { label: string; text: string; accent: string }) {
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
}
