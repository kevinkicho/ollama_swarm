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

import { memo, useMemo, useState } from "react";
import type { TranscriptEntry } from "../../types";
import { summarizeAgentJson } from "../../../../shared/src/summarizeAgentJson";
import { agentBubblePalette, hueForAgent } from "../agentPalette";
import { isBrainAgentName, textMentionsBrainAlias } from "@ollama-swarm/shared/brainAlias";
import {
  AgentJsonBubble,
  CollapsibleBlock,
  JsonPrettyBubble,
  tryPrettyJson,
} from "./JsonBubbles";
import { WorkerHunksBubble, tryParseWorkerHunks } from "./WorkerHunksBubble";
import { RunFinishedGrid, SeedAnnounceGrid } from "./RunFinishedGrid";
import { DebateVerdictBubble } from "./DebateVerdictBubble";
import { RunStartDivider } from "./RunStartDivider";
import { formatServerSummary } from "../../../../shared/src/formatServerSummary";
import { ToolCallsBlock } from "./ToolCallsBlock";
import {
  BubbleToggleRow,
  PromptContentPanel,
  ThinkingContentPanel,
  ToolTraceContentPanel,
  resolveAgentDisplayText,
  resolveEntryPrompt,
  resolveEntryThinking,
  resolveEntryToolTrace,
  type ResolvedToolTraceEntry,
} from "./AgentThinking";
import { ContractBubble } from "./ContractBubble";
import { AuditorVerdictBubble } from "./AuditorVerdictBubble";
import { HunkReviewBubble } from "./HunkReviewBubble";
import { TodosBubble } from "./TodosBubble";
// New components for transcript UI improvements

import { AgentAvatar } from "./AgentAvatar";
import { AuditReviewCard } from "./AuditReviewCard";
import { tryRenderCouncilMarkers } from "./CouncilCycleDivider";
import { ExecutionStatusBubble } from "./ExecutionStatusBubble";
import { CouncilDraftBubble } from "./CouncilDraftBubble";
import { CouncilSynthesisBubble } from "./CouncilSynthesisBubble";
import { PlannerBriefBubble } from "./PlannerBriefBubble";
import { CompactPipelineStatusLine } from "./CompactPipelineStatusLine";
import { isCompactPipelineStatus } from "./compactPipelineStatus";

export const MessageBubble = memo(function MessageBubble({ entry }: { entry: TranscriptEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString();
  // Wrap every entry in a stable div so Playwright + other DOM
  // inspectors can address each transcript entry without relying on
  // class names that change with restyles. data-summary-kind is
  // omitted when no summary is attached (server didn't tag the entry)
  // so absence is itself a signal.
  return (
    <div
      data-entry-id={entry.id}
      data-entry-role={entry.role}
      className="transcript-bubble box-border"
      style={{ margin: 0, padding: 0 }} /* ensure no extra margins leak into measured height */
      {...(entry.summary?.kind ? { "data-summary-kind": entry.summary.kind } : {})}
      {...(typeof entry.agentIndex === "number" ? { "data-agent-index": entry.agentIndex } : {})}
      {...(entry.thoughts ? { "data-has-thoughts": "true" } : {})}
      {...(entry.toolCalls && entry.toolCalls.length > 0 ? { "data-has-tool-calls": String(entry.toolCalls.length) } : {})}
    >
      {/* Task #229 (2026-04-27 evening): render XML pseudo-tool-call
          markers as a collapsed amber block. Separate from thoughts
          because they're a different kind of leaked-intent signal —
          these are tool invocations the model emitted as text instead
          of via the SDK function. */}
      {entry.toolCalls && entry.toolCalls.length > 0 ? (
        <ToolCallsBlock markers={entry.toolCalls} />
      ) : null}
      {entry.role === "system" ? (
        <SystemBubble entry={entry} ts={ts} />
      ) : entry.role === "user" ? (
        <CollapsibleBlock
          className="rounded-md border border-ink-600 bg-ink-800 p-3 text-sm"
          header={
            <div className="text-xs text-ink-400 mb-1 flex items-center gap-2">
              <span>you · {ts}</span>
              {entry.intent ? (
                <span
                  className={`inline-block px-1.5 py-0 text-[9px] uppercase tracking-wider rounded ${
                    entry.intent === "suggest"
                      ? "bg-sky-900/50 text-sky-300"
                      : entry.intent === "ask"
                        ? "bg-violet-900/50 text-violet-300"
                        : "bg-amber-900/50 text-amber-300"
                  }`}
                >
                  {entry.intent}
                </span>
              ) : null}
            </div>
          }
          text={entry.text}
        />
      ) : (
        <AgentBubble entry={entry} ts={ts} />
      )}
    </div>
  );
});

function SystemBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
  const councilMarker = tryRenderCouncilMarkers(entry);
  if (councilMarker) return councilMarker;

  // Task #46: detect the structured run-start divider and render it as
  // a horizontal-rule block with the run's metadata.
  if (entry.text.startsWith("▸▸RUN-START▸▸")) {
    return <RunStartDivider text={entry.text} ts={entry.ts} />;
  }

  // Audit review detection — render structured audit review cards
  // Server format: [audit] agent-N review (N chars):\n...
  const auditReviewMatch = entry.text.match(/^\[audit\] agent-(\d+) review \(\d+ chars\):\n([\s\S]*)/);
  if (auditReviewMatch) {
    const agentIndex = parseInt(auditReviewMatch[1]);
    const reviewText = auditReviewMatch[2];
    return <AuditReviewCard text={reviewText} agentIndex={agentIndex} ts={entry.ts} />;
  }

  // Execution result detection — render compact execution status
  // Server format: [execution] agent-N ✓ applied|skipped|working on ...
  if (/^\[execution\] agent-\d+ (✓ applied|skipped|✗|working on)/.test(entry.text)) {
    return <ExecutionStatusBubble entry={entry} ts={ts} />;
  }

  // Research pre-pass, literature research, and web_tool hits — one-line status only.
  if (isCompactPipelineStatus(entry)) {
    return <CompactPipelineStatusLine entry={entry} ts={ts} />;
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
  // 2026-04-27 (evening): quota pause/resume ribbons. Same colored-
  // ribbon pattern as verifier_verdict. Amber for paused, emerald for
  // resumed. Pause/resume events are runtime-significant — surfacing
  // them as ribbons (vs the default neutral system chip) lets a user
  // scanning the transcript spot pause windows immediately.
  if (entry.summary?.kind === "quota_paused") {
    const v = entry.summary;
    return (
      <div className="rounded-md border-2 border-amber-700/70 bg-amber-950/30 px-3 py-2 text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-block bg-amber-900/60 text-amber-200 font-mono uppercase tracking-wider px-1.5 py-0.5 rounded">
            ⏸ paused
          </span>
          <span className="text-ink-400">
            {v.statusCode ? `HTTP ${v.statusCode}` : "quota"} · {ts}
          </span>
        </div>
        {v.reason ? (
          <div className="text-ink-300">
            <span className="text-ink-500">why:</span> {v.reason}
          </div>
        ) : null}
        <div className="text-ink-400">{entry.text}</div>
      </div>
    );
  }
  if (entry.summary?.kind === "quota_resumed") {
    const v = entry.summary;
    const pausedMin = (v.pausedMs / 60_000).toFixed(1);
    const totalMin = (v.totalPausedMs / 60_000).toFixed(1);
    return (
      <div className="rounded-md border-2 border-emerald-700/70 bg-emerald-950/30 px-3 py-2 text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-block bg-emerald-900/60 text-emerald-200 font-mono uppercase tracking-wider px-1.5 py-0.5 rounded">
            ▶ resumed
          </span>
          <span className="text-ink-400">paused {pausedMin}m · total {totalMin}m · {ts}</span>
        </div>
        <div className="text-ink-400">{entry.text}</div>
      </div>
    );
  }
  // 2026-04-27: deliverable "Saved to <filename>" card for end-of-run
  // artifact exports. Previously fell through to the generic system bubble
  // — now renders a green-bordered card with filename, size, section count,
  // and a clickable link text so the user can grab a portable artifact
  // (paste into PR, issue, design doc) without grepping the summary JSON.
  if (entry.summary?.kind === "deliverable") {
    const d = entry.summary;
    return (
      <div className="rounded-md border-2 border-emerald-700/60 bg-emerald-950/20 px-3 py-2 text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-block bg-emerald-900/60 text-emerald-200 font-mono uppercase tracking-wider px-1.5 py-0.5 rounded text-[10px]">
            deliverable
          </span>
          <span className="text-ink-400">system · {ts}</span>
        </div>
        <div className="text-emerald-200 font-mono">{entry.text}</div>
        <div className="flex gap-3 text-ink-500">
          <span>{d.filename}</span>
          <span>{d.sectionTitles.length} section{d.sectionTitles.length !== 1 ? "s" : ""}</span>
          <span>{d.bytes.toLocaleString()} bytes</span>
          <span className="text-ink-600">{d.preset}</span>
        </div>
      </div>
    );
  }
  // 2026-04-27: agents-ready expandable summary. Replaces the bare
  // "N/M agents ready on ports X, Y, Z" line with a chip + click-to-
  // expand per-agent grid showing port, role, model, sessionId, and
  // warmup elapsed. Lets users RCA cold-start chains without grepping
  // diag logs.
  if (entry.summary?.kind === "agents_ready") {
    return <AgentsReadyBubble summary={entry.summary} fallbackText={entry.text} ts={ts} />;
  }

  // Prototype for proactive Brain suggestions (injected via brainService.injectSuggestion + transcript_append)
  if (entry.summary?.kind === "brain_suggestion" || (entry.text && entry.text.includes('[brain suggestion]'))) {
    return (
      <div className="rounded-md border-2 border-violet-700/60 bg-violet-950/20 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-block bg-violet-900/60 text-violet-200 font-mono uppercase tracking-wider px-1.5 py-0.5 rounded text-[10px]">🧠 Brain suggestion</span>
          <span className="text-ink-400">{ts}</span>
        </div>
        <div className="text-violet-100">{entry.text}</div>
      </div>
    );
  }
  // 2026-04-26 fix: distinct visual style for transient parser/repair
  // recovery messages. These are normal recovery (system caught a bad
  // response and is retrying) — they're not real errors but they LOOK
  // like them in the default neutral system bubble. Amber chip signals
  // "transient, in recovery" so users don't read them as fatal.
  // W17: failover messages get a distinct violet/amber style so provider
  // shifts are immediately visible in the transcript.
  const isFailover = entry.text.includes("failover:");
  if (isFailover) {
    const match = entry.text.match(/\[([^\]]+)\]\s*failover:\s*(\S+)\s*→\s*(\S+)\s*\(([^)]+)\)/);
    const agentId = match?.[1] ?? entry.agentId ?? "agent";
    const from = match?.[2] ?? "?";
    const to = match?.[3] ?? "?";
    const reason = match?.[4] ?? "";
    return (
      <div className="border-l-2 border-violet-500/60 pl-3 py-1 text-xs font-mono">
        <div className="text-violet-400/80 mb-0.5">
          <span className="inline-block px-1 py-0 text-[9px] uppercase tracking-wider rounded bg-violet-900/40 mr-1.5">
            failover
          </span>
          {agentId} · {ts}
        </div>
        <div className="text-amber-200/70">
          {from} <span className="text-violet-400">→</span> {to}
        </div>
        {reason ? (
          <div className="text-ink-500 mt-0.5">{reason}</div>
        ) : null}
      </div>
    );
  }
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
  // If the entry carries a summary kind that wasn't handled above, flag
  // it so a new server-side kind surfaces immediately in dev — this
  // prevents silent rendering failures where a novel envelope type falls
  // through to a generic bubble that hides the structured data.
  if (entry.summary?.kind) {
    console.warn(`[MessageBubble] Unhandled system summary kind: "${entry.summary.kind}" — add a SystemBubble branch`);
    return (
      <div className="border-l-2 border-rose-500/40 pl-3 py-1 text-xs">
        <div className="text-rose-400/70 mb-0.5">
          <span className="inline-block px-1 py-0 text-[9px] uppercase tracking-wider rounded bg-rose-900/40 mr-1.5">
            unknown:{entry.summary.kind}
          </span>
          {ts}
        </div>
        <div className="whitespace-pre-wrap text-ink-400 font-mono">{entry.text}</div>
      </div>
    );
  }
  // Low-salience default for routine system chatter to reduce bombardment.
  // Important kinds are already intercepted above with stronger visuals.
  return (
    <CollapsibleBlock
      className="border-l border-ink-700/50 pl-2 py-0.5 text-[11px] text-ink-500/90 font-mono opacity-80"
      header={<div className="text-ink-600 text-[10px] mb-0.5">system · {ts}</div>}
      text={entry.text}
    />
  );
}

function AgentBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
  const thinking = useMemo(() => resolveEntryThinking(entry), [entry]);
  const prompt = useMemo(() => resolveEntryPrompt(entry), [entry]);
  const toolTrace = useMemo(() => resolveEntryToolTrace(entry), [entry]);
  const displayText = useMemo(() => resolveAgentDisplayText(entry), [entry]);
  const hue = hueForAgent(entry.agentIndex);
  // Only label as Brain for actual brain entries (suggestions or explicit brain agentId/index-0 brain),
  // not normal agents that happen to have low index in council planning.
  const isBrain = entry.agentIndex === 0 && (
    isBrainAgentName(entry.agentId ?? '') ||
    entry.summary?.kind === 'brain_suggestion' ||
    textMentionsBrainAlias(entry.text || '') ||
    (entry.id || '').includes('brain')
  );
  const palette = agentBubblePalette(hue, false, isBrain);
  const header = (
    <div className="flex items-center gap-2 text-xs mb-1" style={{ color: palette.header }}>
      <AgentAvatar agentIndex={entry.agentIndex} size="sm" />
      <span>{isBrain ? "🧠 Brain" : `Agent ${entry.agentIndex}`} · {ts}</span>
      {entry.assistKind === "auditor-salvage" ? (
        <span className="inline-block px-1.5 py-0 text-[9px] uppercase tracking-wider rounded bg-amber-900/50 text-amber-300">
          JSON salvage
        </span>
      ) : entry.assistKind === "auditor-diagnostic" ? (
        <span className="inline-block px-1.5 py-0 text-[9px] uppercase tracking-wider rounded bg-rose-900/40 text-rose-300">
          parse diagnostic
        </span>
      ) : null}
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
    if (entry.summary.kind === "planner_brief") {
      return (
        <PlannerBriefBubble
          entry={entry}
          summary={entry.summary}
          header={header}
          className={className}
          style={style}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    if (entry.summary.kind === "council_draft") {
      const label = formatServerSummary(entry.summary);
      const chipColor =
        entry.summary.phase === "draft" ? "text-sky-300" : "text-emerald-300";
      return (
        <CouncilDraftBubble
          entry={entry}
          header={header}
          chipLabel={label}
          chipColor={chipColor}
          className={className}
          style={style}
        />
      );
    }
    if (entry.summary.kind === "debate_turn") {
      const label = formatServerSummary(entry.summary);
      const chipColor =
        entry.summary.role === "judge" ? "text-amber-300" : entry.summary.role === "pro" ? "text-emerald-300" : "text-rose-300";
      const chipHeader = (
        <div>
          {header}
          <div className={`text-[10px] uppercase tracking-wider font-semibold ${chipColor} mb-1`}>
            {label}
          </div>
        </div>
      );
      return (
        <CollapsibleBlock
          className={className}
          style={style}
          header={chipHeader}
          text={displayText}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    // Synthesis-style entries — distinctive bordered wrapper so the
    // consolidated takeaway is visually obvious as the run's "answer",
    // separate from the per-turn drafts above. DRY'd: one helper drives
    // 5 near-identical branches that previously copy-pasted the chip +
    // CollapsibleBlock pattern with different colors and labels.
    if (entry.summary.kind === "council_synthesis") {
      return (
        <CouncilSynthesisBubble
          text={displayText}
          header={header}
          rounds={entry.summary.rounds}
          thinking={thinking}
          prompt={prompt}
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
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    // #303: stigmergy explorer's per-turn annotation. Renders the
    // structured envelope (file + interest/confidence bars + note)
    // as a card BELOW the prose, instead of leaving raw JSON
    // dangling outside any segment.
    if (entry.summary.kind === "stigmergy_annotation") {
      return (
        <StigmergyAnnotationBubble
          header={header}
          text={entry.text}
          summary={entry.summary}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
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
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
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
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
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
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
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
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    // Other server-summary kinds (worker_skip) are JSON envelopes — AgentJsonBubble.
    // ow_assignments gets a nicer list render.
    const oneLine = formatServerSummary(entry.summary);
    if (entry.summary.kind === "ow_assignments") {
      const s = entry.summary;
      return (
        <CollapsibleBlock
          className={className}
          style={style}
          header={
            <div>
              {header}
              <div className="text-[10px] uppercase tracking-wider font-semibold text-sky-300 mb-1">
                ═ Orchestrator assignments · {s.subtaskCount} subtasks ═
              </div>
            </div>
          }
          text={entry.text}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    if (entry.summary.kind === "worker_skip") {
      const s = entry.summary;
      // Transcript UI fix: render worker skips more subtly (compact, low-contrast)
      // so repetitive "already present / no-op" messages don't dominate the view.
      return (
        <div className="rounded px-2 py-1 text-[11px] text-ink-500 border-l-2 border-amber-900/40 bg-amber-950/10 ml-2">
          {header}
          <span className="font-mono">⏭ skip:</span> {s.reason}
        </div>
      );
    }
    if (!["worker_skip", "ow_assignments"].includes(entry.summary.kind)) {
      console.warn(`[MessageBubble] Unhandled agent summary kind: "${entry.summary.kind}" — add an AgentBubble branch`);
    }
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={oneLine}
        json={entry.text}
        thinking={thinking}
        prompt={prompt}
        toolTrace={toolTrace}
      />
    );
  }
  // 2026-04-25: client-side worker_hunks detection for legacy entries
  // whose server-side summary tagging dropped (pre-fix runs OR entries
  // from envelopes the lenient parser couldn't slice). Mirrors the
  // WorkerHunksBubble routing so the diff renderer applies even when
  // summary.kind is missing.
  return (
    <AgentClientFallback
      entry={entry}
      className={className}
      style={style}
      header={header}
      hue={hue}
      thinking={thinking}
      prompt={prompt}
      toolTrace={toolTrace}
    />
  );
}

function AgentClientFallback({
  entry,
  className,
  style,
  header,
  hue,
  thinking,
  prompt,
  toolTrace,
}: {
  entry: TranscriptEntry;
  className: string;
  style: React.CSSProperties;
  header: React.ReactNode;
  hue: number;
  thinking: ReturnType<typeof resolveEntryThinking>;
  prompt: ReturnType<typeof resolveEntryPrompt>;
  toolTrace: ResolvedToolTraceEntry[] | null;
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
        thinking={thinking}
        prompt={prompt}
        toolTrace={toolTrace}
      />
    );
  }
  if (clientSummary) {
    // Phase 3 (UI coherent-fix, 2026-04-27): route to a dedicated
    // structured-expand component when the envelope kind is one we
    // ship a bubble for. Falls back to AgentJsonBubble for kinds
    // marked "unknown" (worker hunks, replanner, etc. — those route
    // via the looseHunks check above OR don't have a dedicated
    // bubble yet).
    if (clientSummary.parsed.kind === "contract") {
      return (
        <ContractBubble
          envelope={clientSummary.parsed}
          header={header}
          className={className}
          style={style}
          thinking={thinking}
          prompt={prompt}
        />
      );
    }
    if (clientSummary.parsed.kind === "auditor") {
      return (
        <AuditorVerdictBubble
          envelope={clientSummary.parsed}
          header={header}
          className={className}
          style={style}
          prompt={prompt}
        />
      );
    }
    if (clientSummary.parsed.kind === "hunk_review") {
      return (
        <HunkReviewBubble
          envelope={clientSummary.parsed}
          rawJson={entry.text}
          header={header}
          className={className}
          style={style}
          prompt={prompt}
        />
      );
    }
    if (clientSummary.parsed.kind === "todos") {
      return (
        <TodosBubble
          envelope={clientSummary.parsed}
          header={header}
          className={className}
          style={style}
        />
      );
    }
    return (
      <AgentJsonBubble
        className={className}
        style={style}
        header={header}
        summary={clientSummary.summary}
        json={clientSummary.json}
        thinking={thinking}
        prompt={prompt}
        toolTrace={toolTrace}
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
        thinking={thinking}
        prompt={prompt}
        toolTrace={toolTrace}
      />
    );
  }
  return (
    <CollapsibleBlock
      className={className}
      style={style}
      header={header}
      text={entry.text}
      thinking={thinking}
      prompt={prompt}
      toolTrace={toolTrace}
    />
  );
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

// #303: stigmergy explorer's per-turn annotation bubble. Renders the
// agent's prose at top, then a structured card with file path +
// interest/confidence bars + the note. The raw JSON envelope used to
// dangle outside the segmenter; now the runner strips it and the
// parsed values render here as readable UI.
function StigmergyAnnotationBubble({
  header,
  text,
  summary,
  thinking,
  prompt,
  toolTrace,
}: {
  header: React.ReactNode;
  text: string;
  summary: { kind: "stigmergy_annotation"; file: string; interest: number; confidence: number; note: string };
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
      {/* Structured annotation card */}
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

// 2026-04-27: agents-ready system bubble. Default state is the same
// terse one-line text the runner emitted ("N/M agents ready on ports
// X, Y, Z"). Click "details" to expand into a per-agent grid showing
// port, role, model, sessionId, warmupMs. Surfaces what previously
// only existed in the diag log so spawn issues are visible in the UI.
function AgentsReadyBubble({
  summary,
  fallbackText,
  ts,
}: {
  summary: Extract<import("../../types").TranscriptEntrySummary, { kind: "agents_ready" }>;
  fallbackText: string;
  ts: string;
}) {
  const [open, setOpen] = useState(false);
  const slowest = summary.agents.reduce(
    (max, a) => (a.warmupMs !== undefined && a.warmupMs > max ? a.warmupMs : max),
    0,
  );
  return (
    <div className="border-l-2 border-ink-500 pl-3 py-1 text-xs text-ink-400 font-mono">
      <div className="flex items-baseline gap-2 text-ink-500 mb-0.5">
        <span>system · {ts}</span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] uppercase tracking-wide hover:text-ink-200"
          title="Per-agent spawn details: role, model, sessionId, warmup elapsed"
        >
          {open ? "hide details" : "details"}
        </button>
        {slowest > 0 ? (
          <span className={slowest > 30000 ? "text-amber-400" : "text-ink-500"}>
            slowest warmup: {(slowest / 1000).toFixed(1)}s
          </span>
        ) : null}
      </div>
      <div className="text-ink-400">{fallbackText}</div>
      {open ? (
        <div className="mt-2 rounded border border-ink-700 bg-ink-950/40 p-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-1">
            preset: {summary.preset} · spawn elapsed: {(summary.spawnElapsedMs / 1000).toFixed(1)}s
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-ink-500">
                <th className="text-left px-1 py-0.5">id</th>
                <th className="text-left px-1 py-0.5">role</th>
                <th className="text-left px-1 py-0.5">model</th>
                <th className="text-left px-1 py-0.5">warmup</th>
                <th className="text-left px-1 py-0.5">session</th>
              </tr>
            </thead>
            <tbody>
              {summary.agents.map((a) => (
                <tr key={a.id} className="border-t border-ink-800">
                  <td className="px-1 py-0.5 text-ink-300">{a.id}</td>
                  <td className="px-1 py-0.5 text-emerald-300">{a.role}</td>
                  <td className="px-1 py-0.5 text-ink-300">{a.model}</td>
                  <td className={`px-1 py-0.5 ${a.warmupMs && a.warmupMs > 30000 ? "text-amber-300" : "text-ink-300"}`}>
                    {a.warmupMs !== undefined ? `${(a.warmupMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="px-1 py-0.5 text-ink-500 break-all">{a.sessionId.slice(0, 18)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}