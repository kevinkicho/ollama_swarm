import { useLayoutEffect, useRef, useState } from "react";
import { extractFirstBalanced } from "../../../../shared/src/extractJson";

export const COLLAPSE_THRESHOLD = 600;
export const JSON_COLLAPSE_THRESHOLD = 2000;
export const MAX_BUBBLE_HEIGHT_PX = 384;

export function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
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
}

export function splitProseAndJson(text: string): { prose: string; json: string } {
  const trimmed = text.trim();
  const fenceIdx = trimmed.indexOf("```json");
  const candidates = [
    trimmed.indexOf("{"),
    trimmed.indexOf("["),
    fenceIdx >= 0 ? fenceIdx : -1,
  ].filter((i) => i >= 0);
  if (candidates.length > 0) {
    const cut = Math.min(...candidates);
    return {
      prose: trimmed.slice(0, cut).trim(),
      json: trimmed.slice(cut).trim(),
    };
  }
  const balanced = extractFirstBalanced(trimmed);
  if (balanced) {
    const idx = trimmed.indexOf(balanced);
    if (idx >= 0) {
      return {
        prose: trimmed.slice(0, idx).trim(),
        json: trimmed.slice(idx).trim(),
      };
    }
  }
  return { prose: trimmed, json: "" };
}

export function AgentJsonBubble({ summary, json, header, className, style }: AgentJsonBubbleProps) {
  const [showJson, setShowJson] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const { prose, json: jsonPart } = splitProseAndJson(json);
  const hasReasoning = prose.length > 0;
  const prettyJson = tryPrettyJson(jsonPart) ?? jsonPart;
  const jsonTooLong = prettyJson.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? prettyJson : prettyJson.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">{header}</div>
        <div className="flex gap-2 shrink-0">
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
      {showReasoning && hasReasoning ? (
        <div className="mt-2 rounded border border-indigo-900/60 bg-indigo-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wide text-indigo-300/80 mb-1">
            Reasoning preamble · {prose.length.toLocaleString()} chars
          </div>
          <div className="whitespace-pre-wrap opacity-80 text-sm max-h-96 overflow-y-auto">
            {prose}
          </div>
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

interface CollapsibleProps {
  text: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
export function CollapsibleBlock({ text, header, className, style }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(false);
  const charLong = text.length > COLLAPSE_THRESHOLD;
  const shown = !charLong || expanded ? text : text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";
  const bodyStyle = expanded ? undefined : { maxHeight: MAX_BUBBLE_HEIGHT_PX, overflow: "hidden" as const };
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
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
