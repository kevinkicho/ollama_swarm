import { memo, useMemo, useState } from "react";
import type { TranscriptEntry } from "../../types";
import type { TranscriptEntrySummary } from "../../../../shared/src/transcriptEntrySummary";
import { formatServerSummary } from "../../../../shared/src/formatServerSummary";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  resolveAgentDisplayText,
  type ResolvedPrompt,
  type ResolvedThinking,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";
import { CollapsibleBlock } from "./JsonBubbles";

type PlannerBriefSummary = Extract<TranscriptEntrySummary, { kind: "planner_brief" }>;

function briefChip(summary: PlannerBriefSummary): { label: string; color: string } {
  const headline = formatServerSummary(summary);
  if (summary.variant === "goal_analysis") {
    return { label: `══ ${headline} ══`, color: "text-teal-300" };
  }
  return { label: `══ ${headline} ══`, color: "text-indigo-300" };
}

export const PlannerBriefBubble = memo(function PlannerBriefBubble({
  entry,
  summary,
  header,
  className,
  style,
  thinking,
  prompt,
  toolTrace,
}: {
  entry: TranscriptEntry;
  summary: PlannerBriefSummary;
  header: React.ReactNode;
  className: string;
  style: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);

  const displayText = useMemo(() => resolveAgentDisplayText(entry), [entry]);
  const chip = briefChip(summary);

  const chipHeader = (
    <div>
      {header}
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${chip.color} mb-1`}>
        {chip.label}
      </div>
      {(thinking || prompt || toolTrace?.length) ? (
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
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? <ToolTraceContentPanel trace={toolTrace} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
    </div>
  );

  return (
    <CollapsibleBlock
      className={className}
      style={style}
      header={chipHeader}
      text={displayText}
    />
  );
});