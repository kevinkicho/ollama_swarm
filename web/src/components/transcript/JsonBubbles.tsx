import { useLayoutEffect, useRef, useState } from "react";

export const COLLAPSE_THRESHOLD = 600;
export const JSON_COLLAPSE_THRESHOLD = 2000;
// Task #75 (2026-04-25): max bubble body height before clip + fade.
// Tall bubbles dominated the transcript viewport when several agents
// produced 50+ line responses. 24rem (~24 lines @ default text size)
// is enough to hold a dense paragraph without the viewport being
// eaten by one bubble.
export const MAX_BUBBLE_HEIGHT_PX = 384;

// Task #38: parse + pretty-print agent text if it's valid JSON.
// Returns the formatted string on success, null otherwise. Strips a
// leading ```json ... ``` fence first since several presets wrap
// envelopes that way. Only returns when the parsed value is an
// object or array — bare strings/numbers/booleans pass through to
// CollapsibleBlock since pretty-printing them adds no value.
export function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Strip a fenced ```json or ``` block if present.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  // Cheap pre-check so we don't run JSON.parse on every prose response.
  const first = candidate.charAt(0);
  if (first !== "{" && first !== "[") return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

export interface AgentJsonBubbleProps {
  summary: string;
  json: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  // 2026-04-26: optional segment split points captured during streaming.
  // When present, the Reasoning panel renders the prose preamble with
  // the same segment structure the user saw live (CollapsedSegment per
  // past segment + last segment expanded). Indices into the FULL response
  // text — splits within the prose region apply to the prose preamble;
  // splits past the JSON boundary are ignored.
  segmentSplitPoints?: number[];
  // Hue passed through so segments use the agent's color palette.
  segmentHue?: number;
}

// Split a model response into prose preamble + JSON payload. Many models
// (especially planner-tier ones in thinking mode) emit chain-of-thought
// reasoning before the structured envelope. Without this, that reasoning
// is hidden behind "View JSON" and rendered as monospace junk.
//
// Heuristic: find the first JSON marker (`{`, `[`, or fenced ```json) —
// everything before it is prose, everything from it on is JSON. Trims
// each side. If no marker is found, returns the whole text as prose.
function splitProseAndJson(text: string): { prose: string; json: string } {
  const trimmed = text.trim();
  // Prefer a fenced block — it's the most explicit boundary.
  const fenceIdx = trimmed.indexOf("```json");
  const candidates = [
    trimmed.indexOf("{"),
    trimmed.indexOf("["),
    fenceIdx >= 0 ? fenceIdx : -1,
  ].filter((i) => i >= 0);
  if (candidates.length === 0) {
    return { prose: trimmed, json: "" };
  }
  const cut = Math.min(...candidates);
  return {
    prose: trimmed.slice(0, cut).trim(),
    json: trimmed.slice(cut).trim(),
  };
}

export function AgentJsonBubble({ summary, json, header, className, style, segmentSplitPoints, segmentHue }: AgentJsonBubbleProps) {
  const [showJson, setShowJson] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showChunks, setShowChunks] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const { prose, json: jsonPart } = splitProseAndJson(json);
  const hasReasoning = prose.length > 0;
  // 2026-04-26: filter segment splits to those within the prose region
  // so the Reasoning panel can render with preserved structure.
  const proseSegments = (() => {
    if (!segmentSplitPoints || segmentSplitPoints.length === 0 || prose.length === 0) return null;
    const proseSplits = segmentSplitPoints.filter((p) => p > 0 && p < prose.length);
    if (proseSplits.length === 0) return null;
    const out: string[] = [];
    let cursor = 0;
    for (const sp of proseSplits) {
      if (sp <= cursor) continue;
      out.push(prose.slice(cursor, sp));
      cursor = sp;
    }
    out.push(prose.slice(cursor));
    return out;
  })();
  // 2026-04-26: full-response streaming-chunks split. Shows the entire
  // response (prose + JSON together) split by all segment points the
  // streaming bubble captured. Works for any envelope — auditor JSON,
  // worker hunks, planner contracts. Without this, JSON-only responses
  // (auditor verdicts, worker hunks) never get a segment view because
  // the prose region is empty.
  const allChunks = (() => {
    if (!segmentSplitPoints || segmentSplitPoints.length === 0) return null;
    const validSplits = segmentSplitPoints.filter((p) => p > 0 && p < json.length);
    if (validSplits.length === 0) return null;
    const out: string[] = [];
    let cursor = 0;
    for (const sp of validSplits) {
      if (sp <= cursor) continue;
      out.push(json.slice(cursor, sp));
      cursor = sp;
    }
    out.push(json.slice(cursor));
    return out;
  })();
  const hasChunks = allChunks !== null && allChunks.length > 1;
  // Pretty-print JSON when it's parseable; otherwise show raw.
  const prettyJson = tryPrettyJson(jsonPart) ?? jsonPart;
  const jsonTooLong = prettyJson.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? prettyJson : prettyJson.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">{header}</div>
        <div className="flex gap-2 shrink-0">
          {hasChunks ? (
            <button
              onClick={() => setShowChunks((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
              title="Show the full response split by streaming pauses — the same segment structure the streaming bubble showed live"
            >
              {showChunks ? "Hide chunks" : `Chunks (${allChunks!.length})`}
            </button>
          ) : null}
          {hasReasoning ? (
            <button
              onClick={() => setShowReasoning((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
              title="Show the chain-of-thought reasoning the model emitted before the JSON"
            >
              {showReasoning ? "Hide reasoning" : `Reasoning (${prose.length.toLocaleString()})`}
            </button>
          ) : null}
          <button
            onClick={() => setShowJson((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
          >
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </div>
      </div>
      <div className="whitespace-pre-wrap">{summary}</div>
      {showChunks && hasChunks ? (
        <div className="mt-2 rounded border border-emerald-900/60 bg-emerald-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wide text-emerald-300/80 mb-1">
            Streaming chunks · {allChunks!.length} segments · {json.length.toLocaleString()} chars total
          </div>
          <ProseSegments segments={allChunks!} hue={segmentHue ?? 200} />
        </div>
      ) : null}
      {showReasoning && hasReasoning ? (
        <div className="mt-2 rounded border border-indigo-900/60 bg-indigo-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wide text-indigo-300/80 mb-1">
            Reasoning preamble · {prose.length.toLocaleString()} chars
            {proseSegments && proseSegments.length > 1 ? ` · ${proseSegments.length} segments` : ""}
          </div>
          {proseSegments && proseSegments.length > 1 ? (
            <ProseSegments segments={proseSegments} hue={segmentHue ?? 200} />
          ) : (
            <CollapsibleBlock
              className=""
              header={null}
              text={prose}
            />
          )}
        </div>
      ) : null}
      {showJson ? (
        <div className="mt-2 rounded border border-ink-700 bg-ink-950 p-2">
          <pre className="text-[11px] font-mono text-ink-300 whitespace-pre-wrap break-all">
            {shownJson}
          </pre>
          {jsonTooLong ? (
            <button
              onClick={() => setJsonExpanded((v) => !v)}
              className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
            >
              {jsonExpanded ? "Show less" : `Show more (${prettyJson.length - JSON_COLLAPSE_THRESHOLD} chars)`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Task #38: render an agent response as a pretty-printed JSON block.
// Used when the response IS valid JSON but no structured summarizer
// recognized its envelope shape. Same collapse-on-overflow + view-
// JSON-toggle UX as AgentJsonBubble, minus the summary line (we don't
// have a one-liner to show — just present the formatted JSON
// directly in a monospace block that's easy to scan).
export function JsonPrettyBubble({
  json,
  header,
  className,
  style,
}: {
  json: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);
  const tooLong = json.length > JSON_COLLAPSE_THRESHOLD;
  const shown = !tooLong || expanded ? json : json.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  return (
    <div className={className} style={style}>
      {header}
      <pre className="text-[11px] font-mono text-ink-200 whitespace-pre-wrap break-all rounded border border-ink-700 bg-ink-950 p-2 mt-1">
        {shown}
      </pre>
      {tooLong ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
        >
          {expanded ? "Show less" : `Show more (${json.length - JSON_COLLAPSE_THRESHOLD} chars)`}
        </button>
      ) : null}
    </div>
  );
}

// 2026-04-26: prose-segments renderer for AgentJsonBubble's Reasoning
// panel. Inlined here (not imported from StreamingDock) to avoid a
// circular import — StreamingDock already imports from this file.
function ProseSegments({ segments, hue }: { segments: string[]; hue: number }) {
  return (
    <div className="space-y-1.5">
      {segments.slice(0, -1).map((seg, i) => (
        <ProseSegment key={i} index={i} text={seg} hue={hue} />
      ))}
      {segments.length > 0 ? (
        <div
          className="whitespace-pre-wrap opacity-90 overflow-y-auto text-sm"
          style={{ maxHeight: `${MAX_BUBBLE_HEIGHT_PX}px` }}
        >
          {segments[segments.length - 1] || " "}
        </div>
      ) : null}
    </div>
  );
}

function ProseSegment({ index, text, hue }: { index: number; text: string; hue: number }) {
  const [open, setOpen] = useState(false);
  const charCount = text.length.toLocaleString();
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  const borderColor = `hsl(${hue} 25% 22%)`;
  const bgColor = `hsl(${hue} 25% 9%)`;
  const headerColor = `hsl(${hue} 30% 70%)`;
  return (
    <div className="rounded border text-xs" style={{ borderColor, background: bgColor }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-black/20 transition"
        style={{ color: headerColor }}
      >
        <span className="font-mono text-[10px]">{open ? "▾" : "▸"}</span>
        <span className="font-semibold">Segment {index + 1}</span>
        <span className="text-ink-500">·</span>
        <span className="text-ink-500 flex-1 truncate" title={preview}>
          {preview}{text.length > 80 ? "…" : ""}
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

interface CollapsibleProps {
  text: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
export function CollapsibleBlock({ text, header, className, style }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(false);
  // Char-length truncation as a defensive cap (don't render 50KB
  // DOM nodes just to clip them visually).
  const charLong = text.length > COLLAPSE_THRESHOLD;
  const shown = !charLong || expanded ? text : text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";
  const bodyStyle = expanded ? undefined : { maxHeight: MAX_BUBBLE_HEIGHT_PX, overflow: "hidden" as const };
  // Task #76: only render Show more when the body ACTUALLY overflows.
  // Previously the button appeared on every collapsed message
  // (including 1-line ones) — clicking did nothing visible. Measure
  // scrollHeight vs clientHeight via a ref to detect real overflow.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    // Only measure when collapsed. Once expanded, the body is
    // unbounded so overflow naturally goes to 0 — re-measuring would
    // flip overflows=false and hide the "Show less" button, leaving
    // the user stranded with no way to collapse back.
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    // 1px tolerance for sub-pixel rendering.
    const isOverflowing = el.scrollHeight - el.clientHeight > 1;
    if (isOverflowing !== overflows) setOverflows(isOverflowing);
  }, [shown, expanded, overflows]);
  const hasMore = charLong || overflows;
  return (
    <div className={className} style={style}>
      {header}
      <div className="relative">
        <div ref={bodyRef} className="whitespace-pre-wrap" style={bodyStyle}>{shown}</div>
        {!expanded && hasMore ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ink-900 to-transparent"
          />
        ) : null}
      </div>
      {hasMore ? (
        !expanded ? (
          <button
            onClick={() => setExpanded(true)}
            className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
          >
            Show more{charLong ? ` (${text.length - COLLAPSE_THRESHOLD} more chars)` : ""}
          </button>
        ) : (
          <button
            onClick={() => setExpanded(false)}
            className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
          >
            Show less
          </button>
        )
      ) : null}
    </div>
  );
}
