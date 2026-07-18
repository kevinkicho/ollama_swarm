import { useMemo, useState } from "react";
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
import { DebateVerdictBubble } from "./DebateVerdictBubble";
import { formatServerSummary } from "../../../../shared/src/formatServerSummary";
import {
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
import { AgentAvatar } from "./AgentAvatar";
import { CouncilDraftBubble } from "./CouncilDraftBubble";
import { CouncilSynthesisBubble } from "./CouncilSynthesisBubble";
import { PlannerBriefBubble } from "./PlannerBriefBubble";
import { DecoratedSynthesisBlock, StigmergyAnnotationBubble } from "./SynthesisBubbles";
import { BuildResultBubble, tryParseBuildResult } from "./BuildResultBubble";

export function AgentBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
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
    if (entry.summary.kind === "build_result") {
      return (
        <BuildResultBubble
          className={className}
          style={style}
          header={header}
          result={{
            ok: entry.summary.ok,
            exitCode: entry.summary.exitCode,
            summary: entry.summary.summary,
          }}
          thinking={thinking}
          prompt={prompt}
          toolTrace={toolTrace}
        />
      );
    }
    if (entry.summary.kind === "contract") {
      // Prefer client ContractBubble when text still parses as full envelope.
      const client = summarizeAgentJson(entry.text);
      if (client?.parsed.kind === "contract") {
        return (
          <ContractBubble
            envelope={client.parsed}
            header={header}
            className={className}
            style={style}
            thinking={thinking}
            prompt={prompt}
          />
        );
      }
      return (
        <CollapsibleBlock
          className={className}
          style={style}
          header={
            <div>
              {header}
              <div className="text-[10px] uppercase tracking-wider font-semibold text-sky-300 mb-1">
                ═ Contract · {entry.summary.criteriaCount} criteria ═
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
    if (entry.summary.kind === "planner_todos") {
      const client = summarizeAgentJson(entry.text);
      if (client?.parsed.kind === "todos") {
        return (
          <TodosBubble
            envelope={client.parsed}
            header={header}
            className={className}
            style={style}
          />
        );
      }
      return (
        <CollapsibleBlock
          className={className}
          style={style}
          header={
            <div>
              {header}
              <div className="text-[10px] uppercase tracking-wider font-semibold text-violet-300 mb-1">
                ═ {entry.summary.todoCount} todos ═
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
    if (
      ![
        "worker_skip",
        "ow_assignments",
        "build_result",
        "contract",
        "planner_todos",
      ].includes(entry.summary.kind)
    ) {
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
  const buildResult = useMemo(() => tryParseBuildResult(entry.text), [entry.text]);

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
  if (buildResult) {
    return (
      <BuildResultBubble
        className={className}
        style={style}
        header={header}
        result={buildResult}
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


