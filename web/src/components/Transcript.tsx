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
    // Task #72: dedicated grid renderers for structured system
    // entries. The plaintext text payload stays in entry.text as a
    // fallback / for older clients, but if the structured summary
    // is present we render it as a proper grid.
    if (entry.summary?.kind === "run_finished") {
      return <RunFinishedGrid summary={entry.summary} ts={entry.ts} />;
    }
    if (entry.summary?.kind === "seed_announce") {
      return <SeedAnnounceGrid summary={entry.summary} ts={entry.ts} />;
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
  // Task #72: structural kinds rendered by dedicated grid components
  // — formatServerSummary is unused for these but the discriminated
  // union demands exhaustiveness. Return a one-line descriptor for
  // safety (e.g. if future code paths render them as plain text).
  if (s.kind === "run_finished") {
    return `Run finished — ${s.stopReason}`;
  }
  if (s.kind === "seed_announce") {
    return `Project seed — ${s.topLevel.length} top-level entries`;
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

// Task #72 (2026-04-25): grid renderer for the end-of-run banner.
// Replaces the plaintext "═══ Run finished ═══" wall-of-text with a
// proper table — header strip with the headline stats, then a per-
// agent table with one row per agent and columns for every metric.
function RunFinishedGrid({
  summary: s,
  ts,
}: {
  summary: Extract<TranscriptEntrySummary, { kind: "run_finished" }>;
  ts: number;
}) {
  const wallClock = formatRuntime(s.wallClockMs);
  const tsStr = new Date(ts).toLocaleTimeString();
  return (
    <div className="rounded border border-emerald-700/50 bg-emerald-950/20 p-3 my-2">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-emerald-300 font-semibold tracking-wide text-xs uppercase">
          ═ Run finished — {s.stopReason} in {wallClock} ═
        </div>
        <div className="text-[10px] text-ink-500 font-mono">{tsStr}</div>
      </div>
      {/* Headline tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Tile label="Files changed" value={s.filesChanged} />
        <Tile label="Commits" value={s.commits ?? 0} />
        <Tile label="+ Lines" value={s.linesAdded} accent="text-emerald-300" />
        <Tile label="− Lines" value={s.linesRemoved} accent="text-rose-300" />
        {s.totalTodos !== undefined ? <Tile label="Total todos" value={s.totalTodos} /> : null}
        {s.skippedTodos !== undefined ? <Tile label="Skipped todos" value={s.skippedTodos} /> : null}
        {s.staleEvents !== undefined ? <Tile label="Stale events" value={s.staleEvents} /> : null}
      </div>
      {s.stopDetail ? (
        <div className="text-[11px] text-ink-400 italic mb-2">Detail: {s.stopDetail}</div>
      ) : null}
      {/* Per-agent grid */}
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
        Per-agent ({s.agents.length})
      </div>
      <div className="overflow-x-auto rounded border border-ink-700/60">
        <table className="w-full text-[11px] font-mono">
          <thead className="bg-ink-800/60 text-ink-400 text-left">
            <tr>
              <th className="px-2 py-1">#</th>
              <th className="px-2 py-1">Role</th>
              <th className="px-2 py-1 text-right">Turns</th>
              <th className="px-2 py-1 text-right">Att</th>
              <th className="px-2 py-1 text-right">Ret</th>
              <th className="px-2 py-1 text-right">Mean</th>
              <th className="px-2 py-1 text-right">Commits</th>
              <th className="px-2 py-1 text-right text-emerald-400/70">+L</th>
              <th className="px-2 py-1 text-right text-rose-400/70">−L</th>
              <th className="px-2 py-1 text-right text-rose-400/70">Rejected</th>
              <th className="px-2 py-1 text-right text-amber-400/70">JSON⚠</th>
              <th className="px-2 py-1 text-right text-rose-500/70">Errors</th>
            </tr>
          </thead>
          <tbody>
            {s.agents.map((a) => (
              <tr key={a.agentIndex} className="border-t border-ink-700/60">
                <td className="px-2 py-1 text-ink-300">{a.agentIndex}</td>
                <td className="px-2 py-1 text-ink-200">{a.role}</td>
                <td className="px-2 py-1 text-right text-ink-200">{a.turns}</td>
                <td className="px-2 py-1 text-right text-ink-300">{a.attempts}</td>
                <td className="px-2 py-1 text-right text-ink-300">{a.retries}</td>
                <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.meanLatencyMs)}</td>
                <td className="px-2 py-1 text-right text-ink-200">{a.commits}</td>
                <td className="px-2 py-1 text-right text-emerald-300">{a.linesAdded}</td>
                <td className="px-2 py-1 text-right text-rose-300">{a.linesRemoved}</td>
                <td className={`px-2 py-1 text-right ${a.rejected > 0 ? "text-rose-300 font-semibold" : "text-ink-300"}`}>{a.rejected}</td>
                <td className={`px-2 py-1 text-right ${a.jsonRepairs > 0 ? "text-amber-300" : "text-ink-300"}`}>{a.jsonRepairs}</td>
                <td className={`px-2 py-1 text-right ${a.promptErrors > 0 ? "text-rose-400 font-semibold" : "text-ink-300"}`}>{a.promptErrors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Task #72: grid renderer for the seed-announce system entry. The
// long top-level entries list collapses into a grid of pill chips
// instead of a comma-separated wall.
function SeedAnnounceGrid({
  summary: s,
  ts,
}: {
  summary: Extract<TranscriptEntrySummary, { kind: "seed_announce" }>;
  ts: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_COUNT = 12;
  const tsStr = new Date(ts).toLocaleTimeString();
  const shown = expanded ? s.topLevel : s.topLevel.slice(0, PREVIEW_COUNT);
  const hidden = s.topLevel.length - shown.length;
  return (
    <div className="rounded border border-sky-700/40 bg-sky-950/20 p-3 my-2">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-sky-300 font-semibold tracking-wide text-xs uppercase">
          ⤓ Project seed
        </div>
        <div className="text-[10px] text-ink-500 font-mono">{tsStr}</div>
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs font-mono mb-2">
        <div className="text-ink-500">Repo</div>
        <div className="text-ink-200 break-all">
          <a href={s.repoUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200 underline">{s.repoUrl}</a>
        </div>
        <div className="text-ink-500">Clone</div>
        <div className="text-ink-200 break-all">{s.clonePath}</div>
        <div className="text-ink-500">Top-level</div>
        <div className="text-ink-200">{s.topLevel.length} entries</div>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {shown.map((name) => (
          <span
            key={name}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-800/60 border border-ink-700 text-ink-300"
          >
            {name}
          </span>
        ))}
      </div>
      {hidden > 0 ? (
        <button
          onClick={() => setExpanded(true)}
          className="text-[10px] underline text-ink-400 hover:text-ink-200"
        >
          + show {hidden} more
        </button>
      ) : expanded && s.topLevel.length > PREVIEW_COUNT ? (
        <button
          onClick={() => setExpanded(false)}
          className="text-[10px] underline text-ink-400 hover:text-ink-200"
        >
          show less
        </button>
      ) : null}
      <div className="text-[10px] text-ink-500 italic mt-2">
        Use file-read / grep / find tools to inspect this repo — start with README.md if present.
      </div>
    </div>
  );
}

function formatRuntime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono text-sm ${accent ?? "text-ink-100"}`}>{value.toLocaleString()}</div>
    </div>
  );
}
