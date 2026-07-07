import { memo, useMemo, useState } from "react";
import { parseCouncilIssues } from "../drafts/councilDraftParse";
import { CouncilIssueList } from "../drafts/CouncilIssueList";
import { CollapsibleBlock, JSON_COLLAPSE_THRESHOLD, tryPrettyJson } from "./JsonBubbles";
import type { TranscriptEntry } from "../../types";

export const CouncilDraftBubble = memo(function CouncilDraftBubble({
  entry,
  header,
  chipLabel,
  chipColor,
  className,
  style,
}: {
  entry: TranscriptEntry;
  header: React.ReactNode;
  chipLabel: string;
  chipColor: string;
  className: string;
  style: React.CSSProperties;
}) {
  const [showJson, setShowJson] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [issuesListExpanded, setIssuesListExpanded] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);

  const issues = useMemo(() => parseCouncilIssues(entry.text), [entry.text]);
  const prettyJson = useMemo(() => tryPrettyJson(entry.text), [entry.text]);
  const thinking = entry.streamSnapshot;
  const thinkingDiffers =
    thinking &&
    thinking.text.trim() !== entry.text.trim() &&
    (tryPrettyJson(thinking.text) ?? thinking.text.trim()) !== (prettyJson ?? entry.text.trim());

  const chipHeader = (
    <div>
      {header}
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
        {chipLabel}
      </div>
    </div>
  );

  if (!issues && !prettyJson) {
    return <CollapsibleBlock className={className} style={style} header={chipHeader} text={entry.text} />;
  }

  const summaryLine = issues
    ? `${issues.length} issue${issues.length === 1 ? "" : "s"} flagged`
    : "Structured response";

  const jsonBody = prettyJson ?? entry.text;
  const jsonTooLong = jsonBody.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? jsonBody : jsonBody.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";

  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1">{chipHeader}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
          {issues ? (
            <button
              onClick={() => setShowIssues((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
            >
              {showIssues ? "Hide issues" : `Show issues (${issues.length})`}
            </button>
          ) : null}
          {thinkingDiffers ? (
            <button
              onClick={() => setShowThinking((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
              title="Raw streamed text visible while the agent was still generating"
            >
              {showThinking
                ? "Hide thinking"
                : `Thinking (${thinking!.streamingMeta?.totalSeconds ?? "?"}s)`}
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
      <div className="text-[11px] text-ink-400 mb-1">{summaryLine}</div>
      {issues && showIssues ? (
        <div className="mb-2">
          <CouncilIssueList
            issues={issues}
            expanded={issuesListExpanded}
            onToggle={() => setIssuesListExpanded((v) => !v)}
          />
        </div>
      ) : null}
      {showThinking && thinkingDiffers ? (
        <div className="mt-2 rounded border border-indigo-900/60 bg-indigo-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wide text-indigo-300/80 mb-1">
            Streamed while generating · {thinking!.text.length.toLocaleString()} chars
          </div>
          <div className="whitespace-pre-wrap opacity-80 text-[11px] font-mono max-h-96 overflow-y-auto">
            {thinking!.text}
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
              {jsonExpanded ? "Show less" : `Show more (${jsonBody.length - JSON_COLLAPSE_THRESHOLD} chars)`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});