import { memo, useMemo, useState } from "react";
import { parseCouncilIssues } from "../drafts/councilDraftParse";
import { CouncilIssueList } from "../drafts/CouncilIssueList";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  resolveEntryPrompt,
  resolveEntryThinking,
} from "./AgentThinking";
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
  const [showPrompt, setShowPrompt] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [issuesListExpanded, setIssuesListExpanded] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);

  const issues = useMemo(() => parseCouncilIssues(entry.text), [entry.text]);
  const prettyJson = useMemo(() => tryPrettyJson(entry.text), [entry.text]);
  const thinking = useMemo(() => resolveEntryThinking(entry), [entry]);
  const prompt = useMemo(() => resolveEntryPrompt(entry), [entry]);

  const chipHeader = (
    <div>
      {header}
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
        {chipLabel}
      </div>
    </div>
  );

  if (!issues && !prettyJson) {
    return (
      <CollapsibleBlock
        className={className}
        style={style}
        header={chipHeader}
        text={entry.text}
        thinking={thinking}
        prompt={prompt}
      />
    );
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
        <BubbleToggleRow
          thinking={thinking}
          prompt={prompt}
          showThinking={showThinking}
          showPrompt={showPrompt}
          onToggleThinking={() => setShowThinking((v) => !v)}
          onTogglePrompt={() => setShowPrompt((v) => !v)}
        >
          {issues ? (
            <button
              onClick={() => setShowIssues((v) => !v)}
              className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
            >
              {showIssues ? "Hide issues" : `Show issues (${issues.length})`}
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
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
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
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
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