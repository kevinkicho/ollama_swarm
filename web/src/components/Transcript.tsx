import { useEffect, useMemo, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types";
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
    // Task #46: detect the structured run-start divider and render it
    // as a horizontal-rule block with the run's metadata. Fall through
    // to the plain-text system bubble for regular system entries.
    if (entry.text.startsWith("▸▸RUN-START▸▸")) {
      return <RunStartDivider text={entry.text} ts={entry.ts} />;
    }
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

  // Unit 54: prefer the server-computed structured summary when
  // present (workers' parsed envelope). The server has the
  // authoritative parser AND avoids the streaming-text edge cases
  // the client summarizer can mis-extract from. Fall through to the
  // client-side summarizer for envelope kinds the server doesn't
  // emit yet (planner / replanner / auditor / contract). Final
  // fallback is the raw text in a collapsible.
  if (entry.summary) {
    // 2026-04-25 fix: council_draft + debate_turn are STRUCTURAL
    // markers — entry.text is plain prose, not JSON. AgentJsonBubble
    // hides the body behind "View JSON" which incorrectly buries the
    // actual draft / debate-turn content. Render the prose directly
    // with the structural label as a small header chip instead.
    if (entry.summary.kind === "council_draft" || entry.summary.kind === "debate_turn") {
      const label = formatServerSummary(entry.summary);
      const chipColor =
        entry.summary.kind === "council_draft"
          ? entry.summary.phase === "draft" ? "text-sky-300" : "text-emerald-300"
          : entry.summary.role === "judge" ? "text-amber-300" : entry.summary.role === "pro" ? "text-emerald-300" : "text-rose-300";
      const chipHeader = (
        <div>
          {header}
          <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
            {label}
          </div>
        </div>
      );
      return <CollapsibleBlock className={className} style={style} header={chipHeader} text={entry.text} />;
    }
    // Other server-summary kinds (worker_hunks / ow_assignments /
    // worker_skip) are JSON envelopes — AgentJsonBubble is correct.
    const oneLine = formatServerSummary(entry.summary);
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={oneLine}
        json={entry.text}
      />
    );
  }
  const clientSummary = useMemo(() => summarizeAgentJson(entry.text), [entry.text]);
  if (clientSummary) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={clientSummary.summary}
        json={clientSummary.json}
      />
    );
  }
  // Task #38: when the agent response is raw JSON that no structured
  // summarizer recognized (e.g. orchestrator-worker assignments
  // envelope, council reveal verdict, novel envelope shapes) — pretty-
  // print it in a code block instead of the bare-text wall the
  // CollapsibleBlock would otherwise render. Falls through cleanly to
  // CollapsibleBlock if the text isn't valid JSON.
  const prettyJson = useMemo(() => tryPrettyJson(entry.text), [entry.text]);
  if (prettyJson) {
    return (
      <JsonPrettyBubble
        className={className}
        style={style}
        header={header}
        json={prettyJson}
      />
    );
  }
  return <CollapsibleBlock className={className} style={style} header={header} text={entry.text} />;
}

// Task #38: parse + pretty-print agent text if it's valid JSON.
// Returns the formatted string on success, null otherwise. Strips a
// leading ```json ... ``` fence first since several presets wrap
// envelopes that way. Only returns when the parsed value is an
// object or array — bare strings/numbers/booleans pass through to
// CollapsibleBlock since pretty-printing them adds no value.
function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Strip a fenced ```json or ``` block if present.
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  // Cheap pre-check so we don't run JSON.parse on every prose response.
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

// Unit 54: render the discriminated server-side summary as a single
// human line. Mirrors the prose used by summarizeAgentJson for the
// equivalent worker shapes so users don't see two different formats
// depending on which path computed the summary.
function formatServerSummary(s: TranscriptEntrySummary): string {
  if (s.kind === "worker_skip") {
    return `Declined: ${s.reason}`;
  }
  // Task #43: orchestrator-worker assignments → one-line summary plus a
  // bullet block. Kept as a single string for the AgentJsonBubble path;
  // line breaks render via whitespace-pre-wrap.
  if (s.kind === "ow_assignments") {
    const lead =
      s.subtaskCount === 1
        ? `Orchestrator assigned 1 subtask:`
        : `Orchestrator assigned ${s.subtaskCount} subtasks:`;
    const lines = s.assignments.map(
      (a) => `  → agent-${a.agentIndex}: ${a.subtask}`,
    );
    return [lead, ...lines].join("\n");
  }
  // Phase 2b/2c: structural markers (council_draft, debate_turn) carry
  // metadata for preset-specific panels but don't have a useful
  // one-line form — fall back to a short descriptor so Bubble's
  // summary display isn't empty.
  if (s.kind === "council_draft") {
    return `Council · round ${s.round} · ${s.phase}`;
  }
  if (s.kind === "debate_turn") {
    return `Debate · round ${s.round} · ${s.role.toUpperCase()}`;
  }
  // worker_hunks
  const opParts: string[] = [];
  if (s.ops.replace > 0) opParts.push(`${s.ops.replace} replace`);
  if (s.ops.create > 0) opParts.push(`${s.ops.create} create`);
  if (s.ops.append > 0) opParts.push(`${s.ops.append} append`);
  const opSummary = opParts.length === 1 ? opParts[0] : opParts.join(", ");
  const hunkLabel = s.hunkCount === 1 ? "1 hunk" : `${s.hunkCount} hunks`;
  const where = s.multipleFiles
    ? `across multiple files`
    : s.firstFile
      ? `in ${s.firstFile}`
      : `(no file)`;
  const charsSuffix = s.totalChars > 0 ? ` (${s.totalChars.toLocaleString()} chars)` : "";
  return `Wrote ${hunkLabel} (${opSummary}) ${where}${charsSuffix}`;
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

// Task #46: rich horizontal-rule block rendered in place of the
// plain "— new run started —" system entry. Parses the sentinel
// pipe-encoded text emitted by store.resetForNewRun when it has run
// metadata. Falls back to a minimal divider if parsing fails.
function RunStartDivider({ text, ts }: { text: string; ts: number }) {
  const parsed = parseRunStartDividerText(text);
  const dateStr = new Date(ts).toLocaleString();
  const runIdShort = parsed.runId ? parsed.runId.slice(0, 8) : null;
  return (
    <div className="my-3" role="separator">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-ink-700" />
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold shrink-0">
          New run
        </div>
        <div className="flex-1 h-px bg-ink-700" />
      </div>
      <div className="mt-2 text-xs text-ink-300 font-mono text-center">
        <div>
          {runIdShort ? (
            <span className="text-ink-100 font-semibold">{runIdShort}</span>
          ) : null}
          {runIdShort ? <span className="text-ink-600 mx-2">·</span> : null}
          <span className="text-ink-400">{dateStr}</span>
        </div>
        {parsed.preset || parsed.plannerModel || parsed.workerModel || parsed.agentCount ? (
          <div className="mt-0.5 text-ink-400">
            {parsed.preset ? <span>{parsed.preset}</span> : null}
            {parsed.preset && (parsed.plannerModel || parsed.workerModel) ? (
              <span className="text-ink-600 mx-2">·</span>
            ) : null}
            {parsed.plannerModel === parsed.workerModel && parsed.plannerModel ? (
              <span>{parsed.plannerModel}</span>
            ) : (
              <>
                {parsed.plannerModel ? <span>planner {parsed.plannerModel}</span> : null}
                {parsed.plannerModel && parsed.workerModel ? (
                  <span className="text-ink-600 mx-2">·</span>
                ) : null}
                {parsed.workerModel ? <span>worker {parsed.workerModel}</span> : null}
              </>
            )}
            {parsed.agentCount ? (
              <>
                <span className="text-ink-600 mx-2">·</span>
                <span>{parsed.agentCount} agents</span>
              </>
            ) : null}
          </div>
        ) : null}
        {parsed.repoUrl ? (
          <div className="mt-0.5 text-ink-500 truncate">{parsed.repoUrl}</div>
        ) : null}
      </div>
    </div>
  );
}

function parseRunStartDividerText(text: string): {
  runId?: string;
  preset?: string;
  plannerModel?: string;
  workerModel?: string;
  agentCount?: number;
  repoUrl?: string;
} {
  // Format: "▸▸RUN-START▸▸|runId=<uuid>|preset=<preset>|plannerModel=...|..."
  if (!text.startsWith("▸▸RUN-START▸▸")) return {};
  const segments = text.split("|").slice(1);
  const out: Record<string, string> = {};
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    out[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  const agentCountNum = out.agentCount ? Number(out.agentCount) : undefined;
  return {
    runId: out.runId || undefined,
    preset: out.preset || undefined,
    plannerModel: out.plannerModel || undefined,
    workerModel: out.workerModel || undefined,
    agentCount: agentCountNum && Number.isFinite(agentCountNum) ? agentCountNum : undefined,
    repoUrl: out.repoUrl || undefined,
  };
}

// Task #38: render an agent response as a pretty-printed JSON block.
// Used when the response IS valid JSON but no structured summarizer
// recognized its envelope shape. Same collapse-on-overflow + view-
// JSON-toggle UX as AgentJsonBubble, minus the summary line (we don't
// have a one-liner to show — just present the formatted JSON
// directly in a monospace block that's easy to scan).
function JsonPrettyBubble({
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
