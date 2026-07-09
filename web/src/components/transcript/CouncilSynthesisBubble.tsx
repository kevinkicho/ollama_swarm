import { memo, useMemo, useState, type ReactNode } from "react";

import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  type ResolvedPrompt,
  type ResolvedThinking,
} from "./AgentThinking";
import { COLLAPSE_THRESHOLD, CollapsibleBlock, splitProseAndJson, tryPrettyJson } from "./JsonBubbles";
import { parseCouncilSynthesisText } from "./councilSynthesisParse";

const PREVIEW_COUNT = 3;
const TRUNCATE_DESC = 180;
const TRUNCATE_PROSE = 320;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function synthesisChipLabel(rounds: number): string {
  if (rounds === 0) return "═ Council synthesis · consensus action plan ═";
  return `═ Council synthesis · ${rounds} discussion round${rounds === 1 ? "" : "s"} ═`;
}

export const CouncilSynthesisBubble = memo(function CouncilSynthesisBubble({
  text,
  header,
  rounds,
  className = "",
  style,
  thinking,
  prompt,
}: {
  text: string;
  header: ReactNode;
  rounds: number;
  className?: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
}) {
  const [view, setView] = useState<"summary" | "full" | "json">("summary");
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const parsed = useMemo(() => parseCouncilSynthesisText(text), [text]);
  const fallbackPrettyJson = useMemo(() => tryPrettyJson(text), [text]);

  const chipLabel = synthesisChipLabel(rounds);
  const chipHeader = (
    <div>
      {header}
      <div className="text-[10px] uppercase tracking-wider font-semibold text-emerald-300 mb-1">
        {chipLabel}
      </div>
    </div>
  );

  const wrapperCls =
    `rounded border-2 border-emerald-700/50 bg-emerald-950/15 p-3 text-sm ${className}`.trim();

  if (!parsed) {
    return (
      <CouncilSynthesisProseFallback
        text={text}
        chipHeader={chipHeader}
        prettyJson={fallbackPrettyJson}
        wrapperCls={wrapperCls}
        style={style}
        thinking={thinking}
        prompt={prompt}
      />
    );
  }

  const { todos, prose, prettyJson } = parsed;
  const n = todos.length;

  const tabBtnBase = "px-2 py-0.5 text-[10px] uppercase tracking-wide rounded";
  const activeCls = "bg-emerald-900/50 text-emerald-200 border border-emerald-700/60";
  const inactiveCls = "text-ink-400 hover:text-ink-200 border border-transparent hover:border-ink-600/60";

  return (
    <div className={wrapperCls} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">{chipHeader}</div>
        <BubbleToggleRow
          thinking={thinking}
          prompt={prompt}
          showThinking={showThinking}
          showPrompt={showPrompt}
          onToggleThinking={() => setShowThinking((v) => !v)}
          onTogglePrompt={() => setShowPrompt((v) => !v)}
        />
      </div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}

      <div className="text-ink-200 font-medium mb-1.5">
        {n} actionable change{n === 1 ? "" : "s"} merged from council findings
      </div>

      <div className="flex items-center gap-1 mb-2">
        <button
          type="button"
          className={`${tabBtnBase} ${view === "summary" ? activeCls : inactiveCls}`}
          onClick={() => setView("summary")}
        >
          Summary
        </button>
        <button
          type="button"
          className={`${tabBtnBase} ${view === "full" ? activeCls : inactiveCls}`}
          onClick={() => setView("full")}
        >
          All {n} todo{n === 1 ? "" : "s"}
        </button>
        <button
          type="button"
          className={`${tabBtnBase} ${view === "json" ? activeCls : inactiveCls}`}
          onClick={() => setView("json")}
        >
          JSON
        </button>
      </div>

      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}

      {view === "summary" && (
        <div className="space-y-2 text-[13px]">
          {prose ? (
            <p className="text-ink-300 leading-snug whitespace-pre-wrap">
              {truncate(prose, TRUNCATE_PROSE)}
            </p>
          ) : null}
          <ol className="list-decimal list-inside space-y-1 text-ink-300">
            {todos.slice(0, PREVIEW_COUNT).map((t, i) => (
              <li key={i}>{truncate(t.description, TRUNCATE_DESC)}</li>
            ))}
            {n > PREVIEW_COUNT && (
              <li className="list-none italic text-ink-500 mt-1">
                …+{n - PREVIEW_COUNT} more (click{" "}
                <span className="text-emerald-300">All {n} todos</span> above)
              </li>
            )}
          </ol>
        </div>
      )}

      {view === "full" && (
        <ol
          className="space-y-2 text-[13px] overflow-y-auto list-decimal list-inside"
          style={{ maxHeight: "600px" }}
        >
          {todos.map((t, i) => (
            <li key={i} className="text-ink-300 leading-snug">
              <span className="text-ink-200">{t.description}</span>
              {t.expectedFiles.length > 0 && (
                <div className="mt-0.5 ml-5 flex flex-wrap gap-1">
                  {t.expectedFiles.map((f, j) => (
                    <span
                      key={j}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-800/60 text-ink-400 border border-ink-700/60"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {view === "json" && (
        <pre
          className="text-[11px] font-mono bg-ink-950 border border-ink-700 p-2 rounded overflow-auto"
          style={{ maxHeight: "600px" }}
        >
          {prettyJson}
        </pre>
      )}
    </div>
  );
});

function CouncilSynthesisProseFallback({
  text,
  chipHeader,
  prettyJson,
  wrapperCls,
  style,
  thinking,
  prompt,
}: {
  text: string;
  chipHeader: ReactNode;
  prettyJson: string | null;
  wrapperCls: string;
  style?: React.CSSProperties;
  thinking?: ResolvedThinking | null;
  prompt?: ResolvedPrompt | null;
}) {
  const [showJson, setShowJson] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!prettyJson) {
    return (
      <CollapsibleBlock
        className={wrapperCls}
        style={style}
        header={chipHeader}
        text={text}
        thinking={thinking}
        prompt={prompt}
      />
    );
  }

  const { prose } = splitProseAndJson(text);
  const body = prose || "Structured synthesis response";
  const charLong = body.length > COLLAPSE_THRESHOLD;
  const shown = !charLong || expanded ? body : body.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";

  return (
    <div className={wrapperCls} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">{chipHeader}</div>
        <BubbleToggleRow
          thinking={thinking}
          prompt={prompt}
          showThinking={showThinking}
          showPrompt={showPrompt}
          onToggleThinking={() => setShowThinking((v) => !v)}
          onTogglePrompt={() => setShowPrompt((v) => !v)}
        >
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200"
          >
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </BubbleToggleRow>
      </div>
      <div className="text-[11px] text-ink-400 mb-1">Narrative synthesis (no parseable todo list)</div>
      {showPrompt && prompt ? <PromptContentPanel prompt={prompt} /> : null}
      {showThinking && thinking ? <ThinkingContentPanel thinking={thinking} /> : null}
      {!showJson ? (
        <>
          <div className="whitespace-pre-wrap text-ink-300 text-[13px]">{shown}</div>
          {charLong ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
            >
              {expanded ? "Show less" : `Show more (${body.length - COLLAPSE_THRESHOLD} more chars)`}
            </button>
          ) : null}
        </>
      ) : (
        <pre className="text-[11px] font-mono bg-ink-950 border border-ink-700 p-2 rounded overflow-auto whitespace-pre-wrap break-all">
          {prettyJson}
        </pre>
      )}
    </div>
  );
}