import { useEffect, useMemo, useRef, useState } from "react";
import { useSwarm } from "../state/store";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types";
import { summarizeAgentJson } from "./transcriptSummarize";
import { agentBubblePalette, hueForAgent } from "./agentPalette";
import { StreamingDock } from "./transcript/StreamingDock";
import {
  AgentJsonBubble,
  CollapsibleBlock,
  JsonPrettyBubble,
  tryPrettyJson,
} from "./transcript/JsonBubbles";
import { WorkerHunksBubble, tryParseWorkerHunks } from "./transcript/WorkerHunksBubble";
import { RunFinishedGrid, SeedAnnounceGrid } from "./transcript/RunFinishedGrid";
import { DebateVerdictBubble } from "./transcript/DebateVerdictBubble";
import { RunStartDivider } from "./transcript/RunStartDivider";

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

  const streamingCount = Object.keys(streaming).length;
  const streamingMeta = useSwarm((s) => s.streamingMeta);

  // Task #176 Phase A: 30s safety sweeper — if a streaming entry
  // is "done" but no transcript_append has cleared it, force-clear
  // so the bubble doesn't persist forever on a runner that crashed
  // mid-finalize. clearStreaming is the canonical removal path.
  const clearStreaming = useSwarm((s) => s.clearStreaming);
  useEffect(() => {
    const stuck = Object.entries(streamingMeta).filter(
      ([, m]) => m.status === "done" && m.endedAt && Date.now() - m.endedAt > 30_000,
    );
    if (stuck.length === 0) return;
    for (const [id] of stuck) clearStreaming(id);
  }, [streamingMeta, clearStreaming]);

  // Auto-scroll only when the user hasn't intentionally scrolled up.
  useEffect(() => {
    if (!stickyBottom) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.length, streamingCount, stickyBottom]);

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
        {transcript.length === 0 && streamingCount === 0 ? (
          <div className="text-ink-400 text-sm">Waiting for agents…</div>
        ) : null}
        {transcript.map((e) => (
          <Bubble key={e.id} entry={e} />
        ))}
        {/* Task #173: per-agent streaming dock with collapse-by-default
            + smooth fade-out on completion. Replaces the previous
            "render N inline bubbles, snap-disappear on end" pattern. */}
        <StreamingDock
          streaming={streaming}
          streamingMeta={streamingMeta}
          agents={agents}
        />
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
  const hue = hueForAgent(entry.agentIndex);
  const palette = agentBubblePalette(hue, false);
  const header = (
    <div className="text-xs mb-1" style={{ color: palette.header }}>
      Agent {entry.agentIndex} · {ts}
    </div>
  );
  const style = { borderColor: palette.border, background: palette.background };
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
  // Task #165: pause/resume on Ollama-quota wall
  if (s.kind === "quota_paused") {
    const sc = s.statusCode ? `${s.statusCode}` : "quota";
    return `Paused — Ollama wall (${sc}); probing every 5min until clear`;
  }
  if (s.kind === "quota_resumed") {
    const min = Math.round(s.pausedMs / 60_000);
    return `Resumed — wall cleared after ~${min} min`;
  }
  // worker_hunks (only kind remaining after all the if-returns above)
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
