import { useCallback, useState } from "react";
import { TranscriptExpandableRoot } from "../../hooks/useTranscriptClickAwayCollapse";
import { extractFirstBalanced } from "../../../../shared/src/extractJson";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  type ResolvedPrompt,
  type ResolvedThinking,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";


export const COLLAPSE_THRESHOLD = 600;
export const JSON_COLLAPSE_THRESHOLD = 2000;
export const MAX_BUBBLE_HEIGHT_PX = 384;

export function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Candidates: whole-string fence, embedded fence (prose + ```json … ```),
  // then raw text. Embedded fences were previously left as raw ```json in
  // CollapsibleBlock fallbacks (run 9f449937 council drafts/synthesis).
  const wholeFence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(trimmed);
  const embeddedFence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  const candidates = [
    wholeFence?.[1],
    embeddedFence && embeddedFence[0] !== wholeFence?.[0] ? embeddedFence[1] : null,
    trimmed,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const candidate = raw.trim();
    const first = candidate.charAt(0);
    if (first !== "{" && first !== "[") continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed === null || typeof parsed !== "object") continue;
      return JSON.stringify(parsed, null, 2);
    } catch {
      /* try next candidate */
    }
  }
  return null;
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

export function AgentJsonBubble({
  summary,
  json,
  header,
  className,
  style,
  thinking,
  prompt,
  toolTrace,
}: AgentJsonBubbleProps & {
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [showJson, setShowJson] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const { prose, json: jsonPart } = splitProseAndJson(json);
  const hasReasoning = prose.length > 0;
  const prettyJson = tryPrettyJson(jsonPart) ?? jsonPart;
  const jsonTooLong = prettyJson.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? prettyJson : prettyJson.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  const collapseAll = useCallback(() => {
    setShowJson(false);
    setShowReasoning(false);
    setShowThinking(false);
    setShowPrompt(false);
    setShowToolTrace(false);
    setJsonExpanded(false);
  }, []);
  const isExpanded =
    showJson || showReasoning || showThinking || showPrompt || showToolTrace || jsonExpanded;
  return (
    <TranscriptExpandableRoot
      expanded={isExpanded}
      onCollapse={collapseAll}
      className={className}
      style={style}
    >
      <div className="flex items-start justify-between gap-2">
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
        </BubbleToggleRow>
      </div>
      <div className="whitespace-pre-wrap">{summary}</div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
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
    </TranscriptExpandableRoot>
  );
}

export function JsonPrettyBubble({
  json,
  header,
  className,
  style,
  thinking,
  prompt,
  toolTrace,
}: {
  json: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);
  const tooLong = json.length > JSON_COLLAPSE_THRESHOLD;
  const shown = !tooLong || expanded ? json : json.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  const collapseAll = useCallback(() => {
    setExpanded(false);
    setShowThinking(false);
    setShowPrompt(false);
    setShowToolTrace(false);
  }, []);
  const isExpanded = expanded || showThinking || showPrompt || showToolTrace;
  const hasToggles = thinking || prompt || toolTrace?.length;
  const headerRow = hasToggles ? (
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
  ) : (
    header
  );

  return (
    <TranscriptExpandableRoot
      expanded={isExpanded}
      onCollapse={collapseAll}
      className={className}
      style={style}
    >
      {headerRow}
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
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
    </TranscriptExpandableRoot>
  );
}

interface CollapsibleProps {
  text: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}
export function CollapsibleBlock({ text, header, className, style, thinking, prompt, toolTrace }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);
  const charLong = text.length > COLLAPSE_THRESHOLD;
  const shown = !charLong || expanded ? text : text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";
  const bodyStyle = expanded ? undefined : { maxHeight: MAX_BUBBLE_HEIGHT_PX, overflow: "hidden" as const };
  const hasMore = charLong;
  const hasToggles = thinking || prompt || toolTrace?.length;
  const collapseAll = useCallback(() => {
    setExpanded(false);
    setShowThinking(false);
    setShowPrompt(false);
    setShowToolTrace(false);
  }, []);
  const isExpanded = expanded || showThinking || showPrompt || showToolTrace;

  return (
    <TranscriptExpandableRoot
      expanded={isExpanded}
      onCollapse={collapseAll}
      className={className}
      style={style}
    >
      <div className="mb-2">
        {header}
        {hasToggles ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-ink-800/50 bg-ink-950/35 px-2 py-1">
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
        ) : null}
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
      <div>
        <div className="whitespace-pre-wrap text-ink-300" style={bodyStyle}>{shown}</div>
      </div>
      {hasMore ? (
        !expanded ? (
          <button
            onClick={() => setExpanded(true)}
            className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
          >
            Show more ({text.length - COLLAPSE_THRESHOLD} more chars)
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
    </TranscriptExpandableRoot>
  );
}
