import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types";
import { summarizeAgentJson } from "./transcriptSummarize";

const AGENT_HUE = [140, 200, 260, 30, 320, 70, 180, 240];
const COLLAPSE_THRESHOLD = 600;
const JSON_COLLAPSE_THRESHOLD = 2000;
// Task #75 (2026-04-25): max bubble body height before clip + fade.
// Tall bubbles dominated the transcript viewport when several agents
// produced 50+ line responses. 24rem (~24 lines @ default text size)
// is enough to hold a dense paragraph without the viewport being
// eaten by one bubble.
const MAX_BUBBLE_HEIGHT_PX = 384;

export function Transcript() {
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Task #73: sticky-bottom auto-scroll only when the user is AT
  // the bottom. When they scroll up to read history, freeze the
  // viewport (don't yank them back) and surface a floating "↓ Latest"
  // button that takes them back to the bottom + re-enables sticky.
  const [stickyBottom, setStickyBottom] = useState(true);

  const streamingBubbles = useMemo(
    () =>
      Object.entries(streaming).map(([agentId, text]) => {
        const agent = agents[agentId];
        return { agentId, text, agentIndex: agent?.index ?? 0 };
      }),
    [streaming, agents],
  );

  // Auto-scroll only when the user hasn't intentionally scrolled up.
  useEffect(() => {
    if (!stickyBottom) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, streamingBubbles.length, stickyBottom]);

  // Track scroll position to flip sticky-bottom on/off. 80px buffer
  // so a tiny rendering shimmy doesn't accidentally drop sticky.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    if (atBottom !== stickyBottom) setStickyBottom(atBottom);
  };

  const jumpToLatest = () => {
    setStickyBottom(true);
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="h-full relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto p-4 space-y-3 bg-ink-900"
      >
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
      {!stickyBottom ? (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className="absolute bottom-4 right-4 z-10 px-3 py-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-black/50 flex items-center gap-1 transition"
        >
          <span>↓</span>
          <span>Latest</span>
        </button>
      ) : null}
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
    // Task #151: verifier verdict ribbon. Per-commit gate from #128 — its
    // verdicts get a colored ribbon so they're visible at a glance instead
    // of buried among other system messages. Color per verdict semantics.
    if (entry.summary?.kind === "verifier_verdict") {
      const v = entry.summary;
      const palette = {
        verified: { ring: "border-emerald-700/70 bg-emerald-950/30", chip: "bg-emerald-900/60 text-emerald-200", icon: "✓" },
        partial: { ring: "border-amber-700/70 bg-amber-950/30", chip: "bg-amber-900/60 text-amber-200", icon: "~" },
        false: { ring: "border-rose-700/70 bg-rose-950/30", chip: "bg-rose-900/60 text-rose-200", icon: "✕" },
        unverifiable: { ring: "border-ink-600 bg-ink-800/40", chip: "bg-ink-700 text-ink-300", icon: "?" },
      }[v.verdict];
      return (
        <div className={`rounded-md border-2 ${palette.ring} px-3 py-2 text-xs space-y-1`}>
          <div className="flex items-center gap-2">
            <span className={`inline-block ${palette.chip} font-mono uppercase tracking-wider px-1.5 py-0.5 rounded`}>
              {palette.icon} verifier · {v.verdict}
            </span>
            <span className="text-ink-400">on {v.proposingAgentId}'s diff · {ts}</span>
          </div>
          <div className="text-ink-300">
            <span className="text-ink-500">todo:</span> {v.todoDescription.slice(0, 140)}{v.todoDescription.length > 140 ? "…" : ""}
          </div>
          <div className="text-ink-200 font-mono break-words">
            <span className="text-ink-500">cite:</span> {v.evidenceCitation}
          </div>
          {v.rationale ? (
            <div className="text-ink-400">
              <span className="text-ink-500">why:</span> {v.rationale}
            </div>
          ) : null}
        </div>
      );
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
    // Task #79 + #80: synthesis-style entries — distinctive bordered
    // wrapper so the consolidated takeaway is visually obvious as the
    // run's "answer", separate from the per-turn drafts above.
    if (entry.summary.kind === "council_synthesis") {
      const r = entry.summary.rounds;
      const synHeader = (
        <div>
          {header}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-emerald-300 mb-1">
            ═ Council synthesis · {r} round{r === 1 ? "" : "s"} ═
          </div>
        </div>
      );
      return (
        <CollapsibleBlock
          className="rounded-md p-3 border-2 border-emerald-700/60 bg-emerald-950/20 text-sm"
          style={undefined}
          header={synHeader}
          text={entry.text}
        />
      );
    }
    if (entry.summary.kind === "stigmergy_report") {
      const n = entry.summary.filesRanked;
      const synHeader = (
        <div>
          {header}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-sky-300 mb-1">
            ═ Stigmergy report-out · {n} files ranked ═
          </div>
        </div>
      );
      return (
        <CollapsibleBlock
          className="rounded-md p-3 border-2 border-sky-700/60 bg-sky-950/20 text-sm"
          style={undefined}
          header={synHeader}
          text={entry.text}
        />
      );
    }
    // Task #129: stretch-goal reflection card. Distinct violet styling
    // because it's a forward-looking artifact (next-run launchpad), not
    // a recap of work done.
    if (entry.summary.kind === "stretch_goals") {
      const sg = entry.summary;
      const stretchHeader = (
        <div>
          {header}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-violet-300 mb-1">
            ✦ Stretch goals · {sg.goals.length} ranked · tier {sg.tier} · {sg.committed} commits ✦
          </div>
        </div>
      );
      const list = (
        <ol className="text-sm text-ink-200 list-decimal list-inside space-y-1 mt-1">
          {sg.goals.map((g, i) => (
            <li key={i} className="text-violet-100">{g}</li>
          ))}
        </ol>
      );
      return (
        <div className="rounded-md p-3 border-2 border-violet-700/60 bg-violet-950/20 text-sm">
          {stretchHeader}
          {list}
          <CollapsibleBlock
            className="text-xs text-ink-400 mt-2"
            header={<div className="text-[10px] uppercase tracking-wider text-ink-500 mb-0.5">raw planner response</div>}
            text={entry.text}
          />
        </div>
      );
    }
    // Task #81: structured debate verdict — render as a scorecard
    // grid with PRO/CON columns and the decisive call in the header.
    if (entry.summary.kind === "debate_verdict") {
      return <DebateVerdictBubble verdict={entry.summary} header={header} ts={entry.ts} />;
    }
    // Task #82: map-reduce final-cycle synthesis — distinctive
    // wrapper like council/stigmergy synthesis.
    if (entry.summary.kind === "mapreduce_synthesis") {
      const c = entry.summary.cycle;
      const synHeader = (
        <div>
          {header}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-violet-300 mb-1">
            ═ Map-reduce synthesis · cycle {c} ═
          </div>
        </div>
      );
      return (
        <CollapsibleBlock
          className="rounded-md p-3 border-2 border-violet-700/60 bg-violet-950/20 text-sm"
          style={undefined}
          header={synHeader}
          text={entry.text}
        />
      );
    }
    // Task #102: post-verdict build phase entries. Each role gets a
    // distinct chip color but they all share an indigo border so the
    // post-verdict block reads as a coherent group below the verdict
    // scorecard.
    if (entry.summary.kind === "next_action_phase") {
      const roleLabel =
        entry.summary.role === "announcement" ? "🔨 Build phase begins"
        : entry.summary.role === "implementer" ? "🛠 Implementer (PRO)"
        : entry.summary.role === "reviewer" ? "🔍 Reviewer (CON)"
        : "✓ Signoff (JUDGE)";
      const chipColor =
        entry.summary.role === "implementer" ? "text-emerald-300"
        : entry.summary.role === "reviewer" ? "text-rose-300"
        : entry.summary.role === "signoff" ? "text-amber-300"
        : "text-indigo-300";
      const phaseHeader = (
        <div>
          {header}
          <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
            ═ {roleLabel} ═
          </div>
        </div>
      );
      // Announcement is a system entry — render compact.
      if (entry.summary.role === "announcement") {
        return (
          <div className="rounded-md p-2 border border-indigo-700/60 bg-indigo-950/20 text-xs text-indigo-200">
            {phaseHeader}
            <div className="text-ink-200">{entry.text}</div>
          </div>
        );
      }
      return (
        <CollapsibleBlock
          className="rounded-md p-3 border-2 border-indigo-700/60 bg-indigo-950/20 text-sm"
          style={undefined}
          header={phaseHeader}
          text={entry.text}
        />
      );
    }
    // Task #100: role-diff synthesis — closes the missing-synthesis
    // gap. Same distinctive-wrapper treatment; amber chip to
    // visually distinguish from emerald (council) / sky (stigmergy)
    // / violet (map-reduce).
    if (entry.summary.kind === "role_diff_synthesis") {
      const r = entry.summary.rounds;
      const n = entry.summary.roles;
      const synHeader = (
        <div>
          {header}
          <div className="text-[10px] uppercase tracking-wider font-semibold text-amber-300 mb-1">
            ═ Role-diff synthesis · {r} round{r === 1 ? "" : "s"} · {n} role{n === 1 ? "" : "s"} ═
          </div>
        </div>
      );
      return (
        <CollapsibleBlock
          className="rounded-md p-3 border-2 border-amber-700/60 bg-amber-950/20 text-sm"
          style={undefined}
          header={synHeader}
          text={entry.text}
        />
      );
    }
    // Task #74 (2026-04-25): worker_hunks renders as a real diff view
    // — per hunk, op + file header + search/replace as stacked dim-red /
    // bright-green blocks. The raw JSON envelope was unreadable; this
    // makes "what did the worker actually change?" obvious at a glance.
    // Falls back to AgentJsonBubble if the envelope can't be parsed.
    if (entry.summary.kind === "worker_hunks") {
      const oneLine = formatServerSummary(entry.summary);
      return (
        <WorkerHunksBubble
          className={className}
          style={style}
          header={header}
          summary={oneLine}
          rawJson={entry.text}
        />
      );
    }
    // Other server-summary kinds (ow_assignments / worker_skip)
    // are JSON envelopes — AgentJsonBubble is correct.
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
  // 2026-04-25: client-side worker_hunks detection for legacy entries
  // whose server-side summary tagging dropped (pre-fix runs OR
  // entries from envelopes the lenient parser couldn't slice). Mirrors
  // the WorkerHunksBubble routing so the diff renderer applies even
  // when summary.kind is missing.
  const looseHunks = useMemo(() => tryParseWorkerHunks(entry.text), [entry.text]);
  if (looseHunks) {
    return (
      <WorkerHunksBubble
        className={className}
        style={style}
        header={header}
        summary={`${looseHunks.length} hunk${looseHunks.length === 1 ? "" : "s"}`}
        rawJson={entry.text}
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
  if (s.kind === "council_synthesis") {
    return `Council synthesis (${s.rounds} round${s.rounds === 1 ? "" : "s"})`;
  }
  if (s.kind === "stigmergy_report") {
    return `Stigmergy report-out (${s.filesRanked} files ranked)`;
  }
  if (s.kind === "stretch_goals") {
    return `Stretch goals (${s.goals.length} ranked, tier ${s.tier})`;
  }
  if (s.kind === "verifier_verdict") {
    return `Verifier ${s.verdict} on ${s.proposingAgentId}`;
  }
  if (s.kind === "debate_verdict") {
    return `Debate verdict — ${s.winner.toUpperCase()} (${s.confidence})`;
  }
  if (s.kind === "mapreduce_synthesis") {
    return `Map-reduce synthesis (cycle ${s.cycle})`;
  }
  if (s.kind === "role_diff_synthesis") {
    return `Role-diff synthesis (${s.rounds} round${s.rounds === 1 ? "" : "s"}, ${s.roles} roles)`;
  }
  if (s.kind === "next_action_phase") {
    return `Build phase — ${s.role}`;
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
  // Char-length truncation as a defensive cap (don't render 50KB
  // DOM nodes just to clip them visually).
  const charLong = text.length > COLLAPSE_THRESHOLD;
  const shown = !charLong || expanded ? text : text.slice(0, COLLAPSE_THRESHOLD).trimEnd() + "…";
  const bodyStyle = expanded ? undefined : { maxHeight: MAX_BUBBLE_HEIGHT_PX, overflow: "hidden" as const };
  // Task #76: only render Show more when the body ACTUALLY overflows.
  // Previously the button appeared on every collapsed message
  // (including 1-line ones) — clicking did nothing visible. Measure
  // scrollHeight vs clientHeight via a ref to detect real overflow.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    // Only measure when collapsed. Once expanded, the body is
    // unbounded so overflow naturally goes to 0 — re-measuring would
    // flip overflows=false and hide the "Show less" button, leaving
    // the user stranded with no way to collapse back.
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    // 1px tolerance for sub-pixel rendering.
    const isOverflowing = el.scrollHeight - el.clientHeight > 1;
    if (isOverflowing !== overflows) setOverflows(isOverflowing);
  }, [shown, expanded, overflows]);
  const hasMore = charLong || overflows;
  return (
    <div className={className} style={style}>
      {header}
      <div className="relative">
        <div ref={bodyRef} className="whitespace-pre-wrap" style={bodyStyle}>{shown}</div>
        {!expanded && hasMore ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ink-900 to-transparent"
          />
        ) : null}
      </div>
      {hasMore ? (
        !expanded ? (
          <button
            onClick={() => setExpanded(true)}
            className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
          >
            Show more{charLong ? ` (${text.length - COLLAPSE_THRESHOLD} more chars)` : ""}
          </button>
        ) : (
          <button
            onClick={() => setExpanded(false)}
            className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
          >
            Show less
          </button>
        )
      ) : null}
    </div>
  );
}

// Task #81 (2026-04-25): scorecard renderer for the JUDGE's structured
// verdict. Two-column grid (PRO / CON) with strongest + weakest per
// side, then a footer strip with the decisive call + next action.
function DebateVerdictBubble({
  verdict: v,
  header,
  ts,
}: {
  verdict: Extract<TranscriptEntrySummary, { kind: "debate_verdict" }>;
  header: React.ReactNode;
  ts: number;
}) {
  const tsStr = new Date(ts).toLocaleTimeString();
  const winnerColor =
    v.winner === "pro" ? "text-emerald-300 border-emerald-700/60 bg-emerald-950/20"
    : v.winner === "con" ? "text-rose-300 border-rose-700/60 bg-rose-950/20"
    : "text-amber-300 border-amber-700/60 bg-amber-950/20";
  const winnerLabel = v.winner === "pro" ? "PRO WINS" : v.winner === "con" ? "CON WINS" : "TIE";
  return (
    <div className={`rounded-md p-3 border-2 text-sm ${winnerColor}`}>
      {header}
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <div className="text-xs uppercase tracking-wider font-bold">
          ⚖ {winnerLabel} · confidence: {v.confidence.toUpperCase()}
        </div>
        <div className="text-[10px] text-ink-500 font-mono">round {v.round} · {tsStr}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold mb-1">PRO</div>
          {v.proStrongest ? (
            <div className="text-[11px] text-ink-200 mb-1">
              <span className="text-emerald-400">strongest:</span> {v.proStrongest}
            </div>
          ) : null}
          {v.proWeakest ? (
            <div className="text-[11px] text-ink-300">
              <span className="text-rose-400">weakest:</span> {v.proWeakest}
            </div>
          ) : null}
        </div>
        <div className="rounded border border-rose-700/40 bg-rose-950/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-rose-300 font-semibold mb-1">CON</div>
          {v.conStrongest ? (
            <div className="text-[11px] text-ink-200 mb-1">
              <span className="text-rose-400">strongest:</span> {v.conStrongest}
            </div>
          ) : null}
          {v.conWeakest ? (
            <div className="text-[11px] text-ink-300">
              <span className="text-emerald-400">weakest:</span> {v.conWeakest}
            </div>
          ) : null}
        </div>
      </div>
      {v.decisive ? (
        <div className="rounded border border-ink-700 bg-ink-950/40 p-2 mb-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">Decisive</div>
          <div className="text-[11px] text-ink-200">{v.decisive}</div>
        </div>
      ) : null}
      {v.nextAction ? (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 p-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold mb-1">Next action</div>
          <div className="text-[11px] text-ink-200">{v.nextAction}</div>
        </div>
      ) : null}
    </div>
  );
}

// Task #74 (2026-04-25): readable diff renderer for worker_hunks
// envelopes. Parses the JSON, renders one block per hunk: op + file
// header, then search/replace as stacked code blocks (red for what
// the worker is removing, green for what it's adding). Create / append
// ops only show the green "added" block. Falls back to AgentJsonBubble
// when the JSON is malformed or doesn't contain a hunks array.
interface ParsedHunk {
  op: "replace" | "create" | "append";
  file: string;
  search?: string;
  replace?: string;
  content?: string;
}
function parseLooseJson(raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  // 1. Strict parse first.
  try { return JSON.parse(s); } catch { /* fall through */ }
  // 2. ```json ... ``` fence stripping.
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  // 3. Slice between first `{` and last `}` — handles trailing
  //    garbage (model occasionally appends a stray `]`) and prose
  //    surrounding a JSON envelope.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(s.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
  }
  return undefined;
}
function tryParseWorkerHunks(rawJson: string): ParsedHunk[] | null {
  const parsed = parseLooseJson(rawJson);
  if (typeof parsed !== "object" || parsed === null) return null;
  const hunks = (parsed as { hunks?: unknown }).hunks;
  if (!Array.isArray(hunks)) return null;
  const out: ParsedHunk[] = [];
  for (const h of hunks) {
    if (typeof h !== "object" || h === null) continue;
    const ho = h as Record<string, unknown>;
    const op = ho.op;
    const file = ho.file;
    if (typeof op !== "string" || typeof file !== "string") continue;
    if (op === "replace" && typeof ho.search === "string" && typeof ho.replace === "string") {
      out.push({ op, file, search: ho.search, replace: ho.replace });
    } else if ((op === "create" || op === "append") && typeof ho.content === "string") {
      out.push({ op, file, content: ho.content });
    }
  }
  return out.length > 0 ? out : null;
}
function WorkerHunksBubble({
  summary,
  rawJson,
  header,
  className,
  style,
}: {
  summary: string;
  rawJson: string;
  header: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hunks = useMemo(() => tryParseWorkerHunks(rawJson), [rawJson]);
  // Fallback: if we can't parse, defer to AgentJsonBubble.
  if (!hunks) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={summary}
        json={rawJson}
      />
    );
  }
  // Per-bubble +/- totals — sum across hunks. Right-aligned next to
  // the summary line so the bubble's at-a-glance change footprint
  // matches the per-hunk badges below.
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    const c = countHunkLines(h);
    added += c.added;
    removed += c.removed;
  }
  // Task #75 + #76: cap height + measure actual overflow so the
  // Show more button only appears when there's hidden content.
  const bodyStyle = expanded ? undefined : { maxHeight: MAX_BUBBLE_HEIGHT_PX, overflow: "hidden" as const };
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    // See CollapsibleBlock — skip measurement when expanded so the
    // "Show less" button stays visible.
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    const isOverflowing = el.scrollHeight - el.clientHeight > 1;
    if (isOverflowing !== overflows) setOverflows(isOverflowing);
  }, [hunks, expanded, overflows]);
  return (
    <div className={className} style={style}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1">{header}</div>
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="text-[10px] uppercase tracking-wide text-ink-400 hover:text-ink-200 shrink-0"
        >
          {showRaw ? "Hide raw" : "Raw JSON"}
        </button>
      </div>
      <div className="flex items-baseline gap-2 mb-2 text-[11px]">
        <div className="text-ink-400 flex-1 min-w-0 truncate">{summary}</div>
        {added > 0 ? <div className="text-emerald-300 font-mono tabular-nums shrink-0">+{added}</div> : null}
        {removed > 0 ? <div className="text-rose-300 font-mono tabular-nums shrink-0">−{removed}</div> : null}
      </div>
      <div className="relative">
        <div ref={bodyRef} className="space-y-2" style={bodyStyle}>
          {hunks.map((h, i) => (
            <HunkBlock key={i} hunk={h} index={i} />
          ))}
        </div>
        {!expanded && overflows ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink-900 to-transparent"
          />
        ) : null}
      </div>
      {overflows ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs underline text-ink-400 hover:text-ink-200"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      {showRaw ? (
        <div className="mt-2 rounded border border-ink-700 bg-ink-950 p-2">
          <pre className="text-[10px] font-mono text-ink-300 whitespace-pre-wrap break-all">
            {rawJson}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
function HunkBlock({ hunk: h, index }: { hunk: ParsedHunk; index: number }) {
  const opColor = h.op === "replace" ? "text-amber-300" : h.op === "create" ? "text-emerald-300" : "text-sky-300";
  const counts = countHunkLines(h);
  return (
    <div className="rounded border border-ink-700 overflow-hidden">
      <div className="bg-ink-800/60 px-2 py-1 flex items-baseline gap-2 text-[11px] font-mono">
        <span className="text-ink-500">#{index + 1}</span>
        <span className={`uppercase font-semibold ${opColor}`}>{h.op}</span>
        <span className="text-ink-300 break-all flex-1 min-w-0 truncate" title={h.file}>{h.file}</span>
        {/* Line counters — right-aligned, hidden when 0 (per Kevin's
            review: don't show "+0" or "-0" noise). */}
        {counts.added > 0 ? (
          <span className="text-emerald-300 tabular-nums shrink-0">+{counts.added}</span>
        ) : null}
        {counts.removed > 0 ? (
          <span className="text-rose-300 tabular-nums shrink-0">−{counts.removed}</span>
        ) : null}
      </div>
      {h.op === "replace" ? (
        <>
          <DiffPane label="− search" text={h.search ?? ""} accent="bg-rose-950/40 border-rose-900/40 text-rose-200" />
          <DiffPane label="+ replace" text={h.replace ?? ""} accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200" />
        </>
      ) : (
        <DiffPane
          label={h.op === "create" ? "+ new file" : "+ append"}
          text={h.content ?? ""}
          accent="bg-emerald-950/40 border-emerald-900/40 text-emerald-200"
        />
      )}
    </div>
  );
}

// Count line-equivalents in a hunk's text. Mirrors the server-side
// countNewlines() so the UI's +N/-M badges match the per-agent
// linesAdded/Removed totals server-side. Trailing-newline-tolerant.
function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}
function countHunkLines(h: ParsedHunk): { added: number; removed: number } {
  if (h.op === "replace") {
    return { added: countLines(h.replace ?? ""), removed: countLines(h.search ?? "") };
  }
  return { added: countLines(h.content ?? ""), removed: 0 };
}
function DiffPane({ label, text, accent }: { label: string; text: string; accent: string }) {
  const [expanded, setExpanded] = useState(false);
  const PREVIEW_LINES = 12;
  const lines = text.split("\n");
  const showAll = expanded || lines.length <= PREVIEW_LINES;
  const shown = showAll ? text : lines.slice(0, PREVIEW_LINES).join("\n") + `\n…  (${lines.length - PREVIEW_LINES} more lines)`;
  return (
    <div className={`border-t border-ink-700 ${accent}`}>
      <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <pre className="px-2 pb-1 text-[11px] font-mono whitespace-pre-wrap break-all">{shown}</pre>
      {!showAll ? (
        <button
          onClick={() => setExpanded(true)}
          className="text-[10px] underline px-2 pb-1 opacity-80 hover:opacity-100"
        >
          show all {lines.length} lines
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
  const startedStr = new Date(s.startedAt).toLocaleString();
  const endedStr = new Date(s.endedAt).toLocaleString();
  return (
    <div className="rounded border border-emerald-700/50 bg-emerald-950/20 p-3 my-2">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-emerald-300 font-semibold tracking-wide text-xs uppercase">
          ═ Run finished — {s.stopReason} in {wallClock} ═
        </div>
        <div className="text-[10px] text-ink-500 font-mono">{tsStr}</div>
      </div>
      {/* Identity strip — runId, preset, model, repo, clone path,
          start/end times. Two-column definition list keeps it compact. */}
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono mb-3 px-1">
        {s.runId ? (
          <>
            <div className="text-ink-500">Run ID</div>
            <div className="text-ink-300 break-all">{s.runId}</div>
          </>
        ) : null}
        <div className="text-ink-500">Preset</div>
        <div className="text-ink-200">{s.preset}</div>
        <div className="text-ink-500">Model</div>
        <div className="text-ink-200">{s.model}</div>
        <div className="text-ink-500">Repo</div>
        <div className="text-ink-200 break-all">
          <a href={s.repoUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200 underline">{s.repoUrl}</a>
        </div>
        <div className="text-ink-500">Clone</div>
        <div className="text-ink-300 break-all">{s.clonePath}</div>
        <div className="text-ink-500">Started</div>
        <div className="text-ink-200">{startedStr}</div>
        <div className="text-ink-500">Ended</div>
        <div className="text-ink-200">{endedStr}</div>
        <div className="text-ink-500">Duration</div>
        <div className="text-ink-200">{wallClock}</div>
        <div className="text-ink-500">Stop reason</div>
        <div className={s.stopReason === "completed" ? "text-emerald-300" : s.stopReason === "user" ? "text-ink-200" : "text-amber-300"}>
          {s.stopReason}
          {s.stopDetail ? <span className="text-ink-400 italic"> — {s.stopDetail}</span> : null}
        </div>
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
        <Tile label="Agents" value={s.agents.length} />
        {/* Task #163: run-level token totals. Computed accurately from
            tokenTracker.recent filtered by run window (independent of
            per-agent approximations). */}
        {s.totalPromptTokens !== undefined ? (
          <Tile label="Tokens in" value={fmtTokensCompact(s.totalPromptTokens)} accent="text-sky-300" />
        ) : null}
        {s.totalResponseTokens !== undefined ? (
          <Tile label="Tokens out" value={fmtTokensCompact(s.totalResponseTokens)} accent="text-violet-300" />
        ) : null}
      </div>
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
              {/* Task #163: per-agent token columns. Approximate for
                  parallel runners (council/OW/MR fire concurrent calls
                  so each agent's snapshot delta sees others' tokens too).
                  Sequential runners (round-robin/stigmergy/debate-judge,
                  blackboard planner-only paths) are exact. */}
              <th className="px-2 py-1 text-right text-sky-400/70" title="Approximate for parallel runners — see #163">Tok in</th>
              <th className="px-2 py-1 text-right text-violet-400/70" title="Approximate for parallel runners — see #163">Tok out</th>
            </tr>
          </thead>
          <tbody>
            {s.agents.map((a) => (
              <tr key={a.agentIndex} className="border-t border-ink-700/60">
                <td className="px-2 py-1 text-ink-300">{a.agentIndex}</td>
                <td className="px-2 py-1 text-ink-200">{a.role}</td>
                {/* turns is meaningful when 0 too (means agent never ran) — keep numeric. */}
                <td className="px-2 py-1 text-right text-ink-200">{a.turns}</td>
                {/* 2026-04-25 fine-tune (Kevin): empty/zero numeric cells
                    show "—" with opacity-50 so the column reads as
                    "no data" instead of a real zero. */}
                <NumOrDash value={a.attempts} className="px-2 py-1 text-right text-ink-300" />
                <NumOrDash value={a.retries} className="px-2 py-1 text-right text-ink-300" />
                <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.meanLatencyMs)}</td>
                <NumOrDash value={a.commits} className="px-2 py-1 text-right text-ink-200" />
                <NumOrDash value={a.linesAdded} className="px-2 py-1 text-right text-emerald-300" />
                <NumOrDash value={a.linesRemoved} className="px-2 py-1 text-right text-rose-300" />
                <NumOrDash value={a.rejected} className={`px-2 py-1 text-right ${a.rejected > 0 ? "text-rose-300 font-semibold" : "text-ink-300"}`} />
                <NumOrDash value={a.jsonRepairs} className={`px-2 py-1 text-right ${a.jsonRepairs > 0 ? "text-amber-300" : "text-ink-300"}`} />
                <NumOrDash value={a.promptErrors} className={`px-2 py-1 text-right ${a.promptErrors > 0 ? "text-rose-400 font-semibold" : "text-ink-300"}`} />
                <td className={`px-2 py-1 text-right font-mono ${a.tokensIn != null && a.tokensIn > 0 ? "text-sky-300" : "text-ink-500 opacity-50"}`}>
                  {a.tokensIn != null ? fmtTokensCompact(a.tokensIn) : "—"}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${a.tokensOut != null && a.tokensOut > 0 ? "text-violet-300" : "text-ink-500 opacity-50"}`}>
                  {a.tokensOut != null ? fmtTokensCompact(a.tokensOut) : "—"}
                </td>
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

// Task #163: compact token formatter — same shape as UsageWidget's
// fmtTokens but local to this file to avoid a cross-component import.
function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function Tile({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  // 2026-04-25 fine-tune (Kevin): show "—" with opacity 0.5 when
  // value is 0/null/undefined so empty tiles don't read as a real "0".
  const isEmpty = typeof value === "number" ? !value : !value || value === "0";
  const display = isEmpty ? "—" : (typeof value === "number" ? value.toLocaleString() : value);
  const colorClass = isEmpty ? "text-ink-400 opacity-50" : (accent ?? "text-ink-100");
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono text-sm ${colorClass}`}>{display}</div>
    </div>
  );
}

// 2026-04-25 fine-tune (Kevin): per-agent table cells render zero/null
// values as "—" at opacity-50. Reuses the caller's className for
// padding/alignment, swaps to muted color when empty.
function NumOrDash({ value, className }: { value: number | null | undefined; className: string }) {
  const isEmpty = !value;
  if (isEmpty) {
    return <td className={`${className} opacity-50`}>—</td>;
  }
  return <td className={className}>{value.toLocaleString()}</td>;
}
