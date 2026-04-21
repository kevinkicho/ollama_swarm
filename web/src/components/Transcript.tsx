import { useEffect, useMemo, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry } from "../types";
import { summarizeAgentJson } from "./transcriptSummarize";

const AGENT_HUE = [140, 200, 260, 30, 320, 70, 180, 240];
const COLLAPSE_THRESHOLD = 600;
const JSON_COLLAPSE_THRESHOLD = 2000;

export function Transcript() {
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const endRef = useRef<HTMLDivElement>(null);

  const streamingBubbles = useMemo(
    () =>
      Object.entries(streaming).map(([agentId, text]) => {
        const agent = agents[agentId];
        return { agentId, text, agentIndex: agent?.index ?? 0 };
      }),
    [streaming, agents],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, streamingBubbles.length]);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3 bg-ink-900">
      {transcript.length === 0 && streamingBubbles.length === 0 ? (
        <div className="text-ink-400 text-sm">Waiting for agents…</div>
      ) : null}
      {transcript.map((e) => (
        <Bubble key={e.id} entry={e} />
      ))}
      {streamingBubbles.map((b) => (
        <StreamingBubble key={`streaming-${b.agentId}`} agentIndex={b.agentIndex} text={b.text} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Bubble({ entry }: { entry: TranscriptEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString();
  if (entry.role === "system") {
    return (
      <CollapsibleBlock
        className="border-l-2 border-ink-500 pl-3 py-1 text-xs text-ink-400 font-mono"
        header={<div className="text-ink-500 mb-0.5">system · {ts}</div>}
        text={entry.text}
      />
    );
  }
  if (entry.role === "user") {
    return (
      <CollapsibleBlock
        className="rounded-md border border-ink-600 bg-ink-800 p-3 text-sm"
        header={<div className="text-xs text-ink-400 mb-1">you · {ts}</div>}
        text={entry.text}
      />
    );
  }
  const hue = AGENT_HUE[(entry.agentIndex ?? 1) - 1] ?? 200;
  const header = (
    <div className="text-xs mb-1" style={{ color: `hsl(${hue} 60% 70%)` }}>
      Agent {entry.agentIndex} · {ts}
    </div>
  );
  const style = { borderColor: `hsl(${hue} 30% 30%)`, background: `hsl(${hue} 30% 12%)` };
  const className = "rounded-md p-3 border text-sm";

  const summary = useMemo(() => summarizeAgentJson(entry.text), [entry.text]);
  if (summary) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={summary.summary}
        json={summary.json}
      />
    );
  }
  return <CollapsibleBlock className={className} style={style} header={header} text={entry.text} />;
}

function StreamingBubble({ agentIndex, text }: { agentIndex: number; text: string }) {
  const hue = AGENT_HUE[(agentIndex || 1) - 1] ?? 200;
  return (
    <div
      className="rounded-md p-3 border text-sm relative"
      style={{
        borderColor: `hsl(${hue} 30% 30%)`,
        background: `hsl(${hue} 30% 12%)`,
        boxShadow: `0 0 0 1px hsl(${hue} 50% 30% / 0.4)`,
      }}
    >
      <div className="flex items-center gap-2 text-xs mb-1" style={{ color: `hsl(${hue} 60% 70%)` }}>
        <span>Agent {agentIndex}</span>
        <span className="inline-flex gap-0.5 items-end">
          <Dot hue={hue} delay={0} />
          <Dot hue={hue} delay={150} />
          <Dot hue={hue} delay={300} />
        </span>
      </div>
      <div className="whitespace-pre-wrap opacity-90">{text || " "}</div>
    </div>
  );
}

function Dot({ hue, delay }: { hue: number; delay: number }) {
  return (
    <span
      className="inline-block w-1 h-1 rounded-full animate-pulse"
      style={{ background: `hsl(${hue} 70% 60%)`, animationDelay: `${delay}ms` }}
    />
  );
}

interface AgentJsonBubbleProps {
  summary: string;
  json: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}
function AgentJsonBubble({ summary, json, header, className, style }: AgentJsonBubbleProps) {
  const [showJson, setShowJson] = useState(false);
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const jsonTooLong = json.length > JSON_COLLAPSE_THRESHOLD;
  const shownJson =
    !jsonTooLong || jsonExpanded ? json : json.slice(0, JSON_COLLAPSE_THRESHOLD).trimEnd() + "…";
  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">{header}</div>
        <button
          onClick={() => setShowJson((v) => !v)}
          className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200 shrink-0"
        >
          {showJson ? "Hide JSON" : "View JSON"}
        </button>
      </div>
      <div className="whitespace-pre-wrap">{summary}</div>
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
              {jsonExpanded ? "Show less" : `Show more (${json.length - JSON_COLLAPSE_THRESHOLD} chars)`}
            </button>
          ) : null}
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
function CollapsibleBlock({ text, header, className, style }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > COLLAPSE_THRESHOLD;
  const shown = !isLong || expanded ? text : text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";
  return (
    <div className={className} style={style}>
      {header}
      <div className="whitespace-pre-wrap">{shown}</div>
      {isLong ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
        >
          {expanded ? "Show less" : `Show more (${text.length - COLLAPSE_THRESHOLD} chars)`}
        </button>
      ) : null}
    </div>
  );
}
