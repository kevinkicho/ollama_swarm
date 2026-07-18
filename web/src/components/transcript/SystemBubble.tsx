import { useState } from "react";
import type { TranscriptEntry } from "../../types";
import { CollapsibleBlock } from "./JsonBubbles";
import { RunFinishedGrid, SeedAnnounceGrid } from "./RunFinishedGrid";
import { RunStartDivider } from "./RunStartDivider";
import { AuditReviewCard } from "./AuditReviewCard";
import { tryRenderCouncilMarkers } from "./CouncilCycleDivider";
import { ExecutionStatusBubble } from "./ExecutionStatusBubble";
import { CompactPipelineStatusLine } from "./CompactPipelineStatusLine";
import { isCompactPipelineStatus } from "./compactPipelineStatus";
import { BrainSuggestionBubble } from "./BrainSuggestionBubble";

export function SystemBubble({ entry, ts }: { entry: TranscriptEntry; ts: string }) {
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
  // Transcript storage cap / loop collapse — not a transport failure.
  // Storage-only caps (thoughts/body) use a quieter ink ribbon; generation
  // loops stay amber so multi-minute thrash is still obvious.
  if (
    entry.summary?.kind === "stream_integrity"
    || (entry.text
      && (entry.text.startsWith("[stream-integrity]")
        || entry.text.startsWith("[transcript-cap]")))
  ) {
    const s = entry.summary?.kind === "stream_integrity" ? entry.summary : null;
    const tags = s?.anomalyKinds?.join(", ") ?? "anomaly";
    const isLoop =
      /collapsed|loop/i.test(entry.text ?? "")
      || (s?.anomalyKinds ?? []).some((k) => /loop|collapse/i.test(k));
    const isStorageOnly = !isLoop && /storage-capped|hard-truncated|transcript-cap/i.test(entry.text ?? "");
    const border = isLoop
      ? "border-amber-700/60 bg-amber-950/20"
      : "border-ink-600/50 bg-ink-900/40";
    const badge = isLoop
      ? "bg-amber-900/60 text-amber-100"
      : "bg-ink-700/80 text-ink-200";
    const title = isLoop ? "generation loop" : isStorageOnly ? "transcript cap" : "output policy";
    return (
      <div className={`rounded-md border-2 ${border} px-3 py-2 text-xs space-y-1`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-block ${badge} font-mono uppercase tracking-wider px-1.5 py-0.5 rounded text-[10px]`}>
            {title}
          </span>
          {s ? (
            <span className="text-ink-300 font-mono">
              {s.agentId} · {tags}
            </span>
          ) : null}
          <span className="text-ink-500">system · {ts}</span>
        </div>
        <div className="text-ink-200 font-mono break-words whitespace-pre-wrap">{entry.text}</div>
        {s && !isStorageOnly ? (
          <div className="text-ink-500">
            raw {s.rawChars.toLocaleString()} → body {s.finalChars.toLocaleString()} chars
          </div>
        ) : null}
        {isStorageOnly ? (
          <div className="text-ink-500 text-[10px]">
            Storage only — model generation and apply buffers are not cut mid-stream.
          </div>
        ) : null}
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
  if (entry.summary?.kind === "brain_suggestion" || (entry.text && entry.text.includes('[brain suggestion]')) || (entry.text && entry.text.includes('[🧠 Brain Suggestion]'))) {
    return <BrainSuggestionBubble text={entry.text} ts={ts} />;
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
