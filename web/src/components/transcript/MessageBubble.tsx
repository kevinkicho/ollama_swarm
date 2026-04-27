// V2 Step 4: extracted from Transcript.tsx so the scroll container
// (Transcript.tsx) is just the scroll/sticky-bottom logic and per-entry
// rendering is its own concern.
//
// Was: 416-LOC `Bubble` god-component inside Transcript.tsx alongside
// 90 LOC of `formatServerSummary` helper. Now: this file owns the
// per-entry render (system / user / agent dispatch) and AgentBubble
// owns the agent-message envelope dispatch.
//
// The DRY win: `DecoratedSynthesisBlock` collapses 5+ near-identical
// "chip header + CollapsibleBlock with colored border" branches
// (council_synthesis, stigmergy_report, mapreduce_synthesis,
// role_diff_synthesis, next_action_phase) into one component
// parameterized by hue + label.

import { useMemo } from "react";
import type { TranscriptEntry } from "../../types";
import { summarizeAgentJson } from "../transcriptSummarize";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import { CollapsedSegment } from "./StreamingDock";
import { segmentsFromSplitPoints } from "../useSegmentSplitter";
import {
  AgentJsonBubble,
  CollapsibleBlock,
  JsonPrettyBubble,
  MAX_BUBBLE_HEIGHT_PX,
  tryPrettyJson,
} from "./JsonBubbles";
import { WorkerHunksBubble, tryParseWorkerHunks } from "./WorkerHunksBubble";
import { RunFinishedGrid, SeedAnnounceGrid } from "./RunFinishedGrid";
import { DebateVerdictBubble } from "./DebateVerdictBubble";
import { RunStartDivider } from "./RunStartDivider";
import { formatServerSummary } from "./formatServerSummary";

export function MessageBubble({ entry }: { entry: TranscriptEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString();
  if (entry.role === "system") {
    return <SystemBubble entry={entry} ts={ts} />;
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
  return <AgentBubble entry={entry} ts={ts} />;
}

function SystemBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
  // Task #46: detect the structured run-start divider and render it as
  // a horizontal-rule block with the run's metadata.
  if (entry.text.startsWith("▸▸RUN-START▸▸")) {
    return <RunStartDivider text={entry.text} ts={entry.ts} />;
  }
  // Task #72: dedicated grid renderers for structured system entries.
  if (entry.summary?.kind === "run_finished") {
    return <RunFinishedGrid summary={entry.summary} ts={entry.ts} />;
  }
  if (entry.summary?.kind === "seed_announce") {
    return <SeedAnnounceGrid summary={entry.summary} ts={entry.ts} />;
  }
  // Task #151: verifier verdict ribbon — colored ribbon per verdict
  // semantics so per-commit gate verdicts (#128) are visible at a glance.
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
  // 2026-04-26 fix: distinct visual style for transient parser/repair
  // recovery messages. These are normal recovery (system caught a bad
  // response and is retrying) — they're not real errors but they LOOK
  // like them in the default neutral system bubble. Amber chip signals
  // "transient, in recovery" so users don't read them as fatal.
  const isRecoveryNotice =
    entry.text.includes("did not parse") ||
    entry.text.includes("Issuing repair prompt") ||
    entry.text.includes("transport error") ||
    entry.text.includes("retry ") ||
    entry.text.includes("worker idle but exit-condition") ||
    entry.text.includes("planner call exhausted retries") ||
    entry.text.includes("Trying next fallback agent") ||
    entry.text.includes("Planner call routed to") ||
    entry.text.includes("Replanner JSON invalid") ||
    entry.text.includes("Run halted: aborted") ||
    entry.text.includes("absolute turn cap") ||
    entry.text.includes("Pause probe") ||
    entry.text.includes("Drain watcher");
  if (isRecoveryNotice) {
    return (
      <div className="border-l-2 border-amber-700/60 pl-3 py-1 text-xs text-amber-300/80 font-mono">
        <div className="text-amber-400/70 mb-0.5">
          <span className="inline-block px-1 py-0 text-[9px] uppercase tracking-wider rounded bg-amber-900/40 mr-1.5">
            recovery
          </span>
          {ts}
        </div>
        <div className="whitespace-pre-wrap">{entry.text}</div>
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

function AgentBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
  const hue = hueForAgent(entry.agentIndex);
  const palette = agentBubblePalette(hue, false);
  const header = (
    <div className="text-xs mb-1" style={{ color: palette.header }}>
      Agent {entry.agentIndex} · {ts}
    </div>
  );
  const style = { borderColor: palette.border, background: palette.background };
  const className = "rounded-md p-3 border text-sm";

  // Unit 54: prefer the server-computed structured summary when present
  // (workers' parsed envelope). The server has the authoritative parser
  // AND avoids the streaming-text edge cases the client summarizer can
  // mis-extract. Fall through to client-side summarizer for envelope
  // kinds the server doesn't emit yet.
  if (entry.summary) {
    // 2026-04-25 fix: council_draft + debate_turn are STRUCTURAL markers
    // — entry.text is plain prose, not JSON. AgentJsonBubble would hide
    // the body behind "View JSON" which incorrectly buries the actual
    // draft / debate-turn content. Render the prose directly with the
    // structural label as a small header chip instead.
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
    // Synthesis-style entries — distinctive bordered wrapper so the
    // consolidated takeaway is visually obvious as the run's "answer",
    // separate from the per-turn drafts above. DRY'd: one helper drives
    // 5 near-identical branches that previously copy-pasted the chip +
    // CollapsibleBlock pattern with different colors and labels.
    if (entry.summary.kind === "council_synthesis") {
      const r = entry.summary.rounds;
      return (
        <DecoratedSynthesisBlock
          header={header}
          text={entry.text}
          accent="emerald"
          label={`═ Council synthesis · ${r} round${r === 1 ? "" : "s"} ═`}
        />
      );
    }
    if (entry.summary.kind === "stigmergy_report") {
      const n = entry.summary.filesRanked;
      return (
        <DecoratedSynthesisBlock
          header={header}
          text={entry.text}
          accent="sky"
          label={`═ Stigmergy report-out · ${n} files ranked ═`}
        />
      );
    }
    if (entry.summary.kind === "mapreduce_synthesis") {
      const c = entry.summary.cycle;
      return (
        <DecoratedSynthesisBlock
          header={header}
          text={entry.text}
          accent="violet"
          label={`═ Map-reduce synthesis · cycle ${c} ═`}
        />
      );
    }
    if (entry.summary.kind === "role_diff_synthesis") {
      const r = entry.summary.rounds;
      const n = entry.summary.roles;
      return (
        <DecoratedSynthesisBlock
          header={header}
          text={entry.text}
          accent="amber"
          label={`═ Role-diff synthesis · ${r} round${r === 1 ? "" : "s"} · ${n} role${n === 1 ? "" : "s"} ═`}
        />
      );
    }
    // Task #129: stretch-goal reflection card. Distinct violet styling
    // because it's a forward-looking artifact (next-run launchpad), not
    // a recap of work done. Custom layout (ordered list + raw planner
    // panel) — not a candidate for the DecoratedSynthesisBlock helper.
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
      return (
        <div className="rounded-md p-3 border-2 border-violet-700/60 bg-violet-950/20 text-sm">
          {stretchHeader}
          <ol className="text-sm text-ink-200 list-decimal list-inside space-y-1 mt-1">
            {sg.goals.map((g, i) => (
              <li key={i} className="text-violet-100">{g}</li>
            ))}
          </ol>
          <CollapsibleBlock
            className="text-xs text-ink-400 mt-2"
            header={<div className="text-[10px] uppercase tracking-wider text-ink-500 mb-0.5">raw planner response</div>}
            text={entry.text}
          />
        </div>
      );
    }
    // Task #81: structured debate verdict — render as a scorecard grid
    // with PRO/CON columns and the decisive call in the header.
    if (entry.summary.kind === "debate_verdict") {
      return <DebateVerdictBubble verdict={entry.summary} header={header} ts={entry.ts} />;
    }
    // Task #102: post-verdict build phase entries. Each role gets a
    // distinct chip color but they all share an indigo border so the
    // post-verdict block reads as a coherent group below the verdict
    // scorecard. Announcement is a system-style entry — render compact.
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
    // Task #74 (2026-04-25): worker_hunks renders as a real diff view
    // — per hunk, op + file header + search/replace as stacked
    // dim-red / bright-green blocks. Falls back to AgentJsonBubble if
    // the envelope can't be parsed.
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
    // Other server-summary kinds (ow_assignments / worker_skip) are JSON
    // envelopes — AgentJsonBubble is correct.
    const oneLine = formatServerSummary(entry.summary);
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={oneLine}
        json={entry.text}
        segmentSplitPoints={entry.segmentSplitPoints}
        segmentHue={hue}
      />
    );
  }
  // 2026-04-25: client-side worker_hunks detection for legacy entries
  // whose server-side summary tagging dropped (pre-fix runs OR entries
  // from envelopes the lenient parser couldn't slice). Mirrors the
  // WorkerHunksBubble routing so the diff renderer applies even when
  // summary.kind is missing.
  return <AgentClientFallback entry={entry} className={className} style={style} header={header} hue={hue} />;
}

function AgentClientFallback({
  entry,
  className,
  style,
  header,
  hue,
}: {
  entry: TranscriptEntry;
  className: string;
  style: React.CSSProperties;
  header: React.ReactNode;
  hue: number;
}) {
  // All hooks live in this dedicated component so the conditional
  // returns above don't violate the rules-of-hooks. (Hook count must
  // be stable per render, but transcript entries are append-only so
  // each entry hits exactly one of the upstream branches consistently.)
  const looseHunks = useMemo(() => tryParseWorkerHunks(entry.text), [entry.text]);
  const clientSummary = useMemo(() => summarizeAgentJson(entry.text), [entry.text]);
  const prettyJson = useMemo(() => tryPrettyJson(entry.text), [entry.text]);

  if (looseHunks) {
    return (
      <WorkerHunksBubble
        className={className}
        style={style}
        header={header}
        summary={`${looseHunks.length} hunk${looseHunks.length === 1 ? "" : "s"}`}
        rawJson={entry.text}
        segmentSplitPoints={entry.segmentSplitPoints}
        segmentHue={hue}
      />
    );
  }
  if (clientSummary) {
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={clientSummary.summary}
        json={clientSummary.json}
        segmentSplitPoints={entry.segmentSplitPoints}
        segmentHue={hue}
      />
    );
  }
  // Task #38: when the agent response is raw JSON that no structured
  // summarizer recognized (e.g. orchestrator-worker assignments
  // envelope, council reveal verdict, novel envelope shapes) — pretty-
  // print it in a code block instead of the bare-text wall the
  // CollapsibleBlock would otherwise render.
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
  // 2026-04-26: prose response with preserved segment split points from
  // streaming. Renders the same segment view the user saw live: previous
  // segments collapsed, last segment shown expanded.
  if (entry.segmentSplitPoints && entry.segmentSplitPoints.length > 0) {
    const segments = segmentsFromSplitPoints(entry.text, entry.segmentSplitPoints);
    return (
      <div className={className} style={style}>
        {header}
        <div className="space-y-1.5 mt-1">
          {segments.slice(0, -1).map((seg, i) => (
            <CollapsedSegment key={i} index={i} text={seg} hue={hue} />
          ))}
          {segments.length > 0 ? (
            <div
              className="whitespace-pre-wrap opacity-90 overflow-y-auto"
              style={{ maxHeight: `${MAX_BUBBLE_HEIGHT_PX}px` }}
            >
              {segments[segments.length - 1] || " "}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return <CollapsibleBlock className={className} style={style} header={header} text={entry.text} />;
}

// V2 Step 4 DRY win: 5+ near-identical synthesis branches (council_synthesis,
// stigmergy_report, mapreduce_synthesis, role_diff_synthesis, and the
// non-announcement next_action_phase) all share this exact shape:
//   <CollapsibleBlock with 2-px colored border + bg + chip header>
// Parameterized by accent (one of 4 colors) + label string.
type Accent = "emerald" | "sky" | "violet" | "amber";
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
function DecoratedSynthesisBlock({
  header,
  text,
  accent,
  label,
}: {
  header: React.ReactNode;
  text: string;
  accent: Accent;
  label: string;
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
    />
  );
}
