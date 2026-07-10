import { useState } from "react";
import { CollapsibleBlock } from "./JsonBubbles";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  type resolveEntryPrompt,
  type resolveEntryThinking,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";

// V2 Step 4 DRY win: synthesis branches share this chip + border shape.
export type Accent = "emerald" | "sky" | "violet" | "amber";

const ACCENT_CLASSES: Record<Accent, { wrapper: string; chip: string }> = {
  emerald: {
    wrapper: "rounded-md p-3 border-2 border-emerald-700/60 bg-emerald-950/20 text-sm",
    chip: "text-emerald-300",
  },
  sky: {
    wrapper: "rounded-md p-3 border-2 border-sky-700/60 bg-sky-950/20 text-sm",
    chip: "text-sky-300",
  },
  violet: {
    wrapper: "rounded-md p-3 border-2 border-violet-700/60 bg-violet-950/20 text-sm",
    chip: "text-violet-300",
  },
  amber: {
    wrapper: "rounded-md p-3 border-2 border-amber-700/60 bg-amber-950/20 text-sm",
    chip: "text-amber-300",
  },
};

export function DecoratedSynthesisBlock({
  header,
  text,
  accent,
  label,
  thinking,
  prompt,
  toolTrace,
}: {
  header: React.ReactNode;
  text: string;
  accent: Accent;
  label: string;
  thinking: ReturnType<typeof resolveEntryThinking>;
  prompt: ReturnType<typeof resolveEntryPrompt>;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const { wrapper, chip } = ACCENT_CLASSES[accent];
  const decoratedHeader = (
    <div>
      {header}
      <div className={`text-[10px] uppercase tracking-wider font-semibold ${chip} mb-1`}>
        {label}
      </div>
    </div>
  );
  return (
    <CollapsibleBlock
      className={wrapper}
      style={undefined}
      header={decoratedHeader}
      text={text}
      thinking={thinking}
      prompt={prompt}
      toolTrace={toolTrace}
    />
  );
}

export function StigmergyAnnotationBubble({
  header,
  text,
  summary,
  thinking,
  prompt,
  toolTrace,
}: {
  header: React.ReactNode;
  text: string;
  summary: {
    kind: "stigmergy_annotation";
    file: string;
    interest: number;
    confidence: number;
    note: string;
  };
  thinking: ReturnType<typeof resolveEntryThinking>;
  prompt: ReturnType<typeof resolveEntryPrompt>;
  toolTrace?: ResolvedToolTraceEntry[] | null;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showToolTrace, setShowToolTrace] = useState(false);
  const hasToggles = thinking || prompt || toolTrace?.length;
  return (
    <div className="rounded-md p-3 border-2 border-teal-700/60 bg-teal-950/20 text-sm space-y-2">
      {hasToggles ? (
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
          />
        </div>
      ) : (
        header
      )}
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showToolTrace && toolTrace?.length ? (
        <ToolTraceContentPanel trace={toolTrace} />
      ) : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
      {text && text !== "(empty response)" ? (
        <div className="text-ink-200 whitespace-pre-wrap">{text}</div>
      ) : null}
      <div className="rounded border border-teal-800/60 bg-ink-950/40 p-2 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[9px] uppercase tracking-wider text-teal-400/80">file</span>
          <span className="font-mono text-[12px] text-teal-200 break-all">{summary.file}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <ScoreBar label="interest" value={summary.interest} max={10} hue="teal" />
          <ScoreBar label="confidence" value={summary.confidence} max={10} hue="sky" />
        </div>
        {summary.note ? (
          <div className="text-[11px] text-ink-300 italic leading-snug border-t border-teal-900/40 pt-1.5">
            “{summary.note}”
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ScoreBar({
  label,
  value,
  max,
  hue,
}: {
  label: string;
  value: number;
  max: number;
  hue: "teal" | "sky";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const barColor = hue === "teal" ? "bg-teal-500" : "bg-sky-500";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[9px] uppercase tracking-wider text-ink-500 w-16 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-ink-900 rounded overflow-hidden min-w-[40px]">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono tabular-nums text-ink-300 w-10 text-right">
        {value}/{max}
      </span>
    </div>
  );
}
