import { memo, useState, type ReactNode } from "react";
import { BubbleToggleRow, PromptContentPanel, type ResolvedPrompt } from "./AgentThinking";
import { tryPrettyJson } from "./JsonBubbles";

export interface HunkReviewEnvelope {
  approve: boolean;
  reason: string;
}

export const HunkReviewBubble = memo(function HunkReviewBubble({
  envelope,
  rawJson,
  header,
  className = "",
  style,
  prompt,
}: {
  envelope: HunkReviewEnvelope;
  rawJson: string;
  header: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  prompt?: ResolvedPrompt | null;
}) {
  const [showJson, setShowJson] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const pretty = tryPrettyJson(rawJson) ?? rawJson;

  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1">{header}</div>
        <BubbleToggleRow
          prompt={prompt}
          showThinking={false}
          showPrompt={showPrompt}
          onToggleThinking={() => {}}
          onTogglePrompt={() => setShowPrompt((v) => !v)}
        >
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200 shrink-0"
          >
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </BubbleToggleRow>
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      <div className="flex items-baseline gap-2 text-[13px]">
        <span
          className={`inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded font-semibold shrink-0 ${
            envelope.approve
              ? "bg-emerald-900/40 text-emerald-300"
              : "bg-rose-900/40 text-rose-300"
          }`}
        >
          {envelope.approve ? "Approved" : "Rejected"}
        </span>
        <span className="text-ink-300 min-w-0">{envelope.reason}</span>
      </div>
      {showJson ? (
        <pre className="mt-2 text-[11px] font-mono text-ink-300 whitespace-pre-wrap break-all rounded border border-ink-700 bg-ink-950 p-2">
          {pretty}
        </pre>
      ) : null}
    </div>
  );
});