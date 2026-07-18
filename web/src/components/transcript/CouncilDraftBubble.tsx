import { memo, useMemo, useState } from "react";
import { parseCouncilIssues } from "../drafts/councilDraftParse";
import { CouncilIssueList } from "../drafts/CouncilIssueList";
import {
  parseDeliberateEnvelopes,
  stanceChipClass,
} from "../drafts/deliberateParse";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  resolveAgentDisplayText,
  resolveEntryPrompt,
  resolveEntryThinking,
  resolveEntryToolTrace,
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
  const [showToolTrace, setShowToolTrace] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [issuesListExpanded, setIssuesListExpanded] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);

  const displayText = useMemo(() => resolveAgentDisplayText(entry), [entry]);
  const issues = useMemo(() => parseCouncilIssues(displayText), [displayText]);
  const deliberates = useMemo(() => parseDeliberateEnvelopes(displayText), [displayText]);
  const prettyJson = useMemo(() => tryPrettyJson(displayText), [displayText]);
  const thinking = useMemo(() => resolveEntryThinking(entry), [entry]);
  const prompt = useMemo(() => resolveEntryPrompt(entry), [entry]);
  const toolTrace = useMemo(() => resolveEntryToolTrace(entry), [entry]);
  const incomplete = /draft incomplete|draft failed/i.test(displayText);

  const chipHeader = (
    <div>
      {header}
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
        {chipLabel}
      </div>
    </div>
  );

  // Peer ```deliberate envelopes (2010479c) — structured card, not raw fence dump.
  if (deliberates.length > 0 && !issues) {
    return (
      <div className={className} style={style}>
        <div className="mb-2">
          {chipHeader}
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
        </div>
        {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
        {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
        {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
        <div className="space-y-2">
          {deliberates.map((d, i) => (
            <div
              key={i}
              className="rounded-md border border-ink-700/60 bg-ink-950/50 px-2.5 py-2 text-[12px] text-ink-200"
            >
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span
                  className={`inline-block px-1.5 py-px rounded border text-[10px] uppercase tracking-wide font-semibold ${stanceChipClass(d.stance)}`}
                >
                  {d.stance}
                </span>
                {d.to ? (
                  <span className="text-[10px] text-ink-500 font-mono">→ {d.to}</span>
                ) : null}
              </div>
              <div className="text-[11px] text-ink-400 mb-0.5">
                <span className="text-ink-500">subject</span> {d.subject}
              </div>
              <div className="text-ink-100 leading-snug mb-1">{d.claim}</div>
              {d.why ? (
                <div className="text-[11px] text-ink-400 leading-snug">
                  <span className="text-ink-500">why </span>
                  {d.why}
                </div>
              ) : null}
              {d.evidence.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {d.evidence.map((ev) => (
                    <span
                      key={ev}
                      className="font-mono text-[10px] px-1 py-px rounded bg-ink-900 text-ink-400 border border-ink-800"
                    >
                      {ev}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!issues && !prettyJson) {
    return (
      <div className={className} style={style}>
        {incomplete ? (
          <div className="mb-1.5 text-[11px] text-amber-300/90 border border-amber-900/40 bg-amber-950/20 rounded px-2 py-1">
            Draft incomplete — explore hit tool-loop limits; partial salvage below. Prefer emit-only or fewer tools next round.
          </div>
        ) : null}
        <CollapsibleBlock
          className=""
          style={{}}
          header={chipHeader}
          text={displayText}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      </div>
    );
  }

  const summaryLine = issues
    ? `${issues.length} issue${issues.length === 1 ? "" : "s"} flagged`
    : "Structured response";

  const jsonBody = prettyJson ?? displayText;
  const jsonTooLong = jsonBody.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? jsonBody : jsonBody.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";

  return (
    <div className={className} style={style}>
      <div className="mb-2">
        {chipHeader}
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
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
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