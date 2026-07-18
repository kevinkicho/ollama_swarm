import { useState } from "react";
import { runOutcomeHeadline } from "@ollama-swarm/shared/formatServerSummary";
import { AgentStatsTable, rowsFromRunFinishedAgents } from "../AgentStatsTable";
import type { TranscriptEntrySummary } from "../../types";

// Task #72 (2026-04-25): grid renderer for the end-of-run banner.
// Replaces the plaintext "═══ Run finished ═══" wall-of-text with a
// proper table — header strip with the headline stats, then a per-
// agent table with one row per agent and columns for every metric.
//
// Phase 4 stability: structure is fixed at render (no late async content).
// Dynamic parts (n agents, conditional tiles) are accounted in estimateSize.
// Internal vertical spacing kept minimal (no excess mb- that would vary measured height).
// SeedAnnounceGrid preview is count-based for initial height predictability.
export function RunFinishedGrid({
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
  // Issue #2 fix (2026-04-27): the bubble was always emerald, so even
  // a 0-work "no-progress" run looked like a green successful completion.
  // Color now follows stopReason — emerald only for true completed; amber
  // for no-progress / cap-trips; ink for user-stop; rose for crashes.
  const palette = paletteForStopReason(s.stopReason);
  const headline = runOutcomeHeadline(s.stopReason);
  return (
    <div className={`rounded border ${palette.border} ${palette.bg} p-3`}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className={`${palette.title} font-semibold tracking-wide text-xs uppercase`}>
          ═ {headline} — {s.stopReason} in {wallClock} ═
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
        <div className={
          s.stopReason === "completed" ? "text-emerald-300"
            : s.stopReason === "crash" || s.stopReason === "crashed" ? "text-rose-300"
            : s.stopReason === "user" ? "text-ink-200"
            : "text-amber-300"
        }>
          {s.stopReason}
          {s.stopDetail ? <span className="text-ink-400 italic"> — {s.stopDetail}</span> : null}
        </div>
      </div>
      {/* Headline tiles — zeroIsData for counters so 0 commits/skipped is not "—" */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Tile label="Files changed" value={s.filesChanged} zeroIsData />
        <Tile label="Commits" value={s.commits ?? 0} zeroIsData />
        {/* Only show line tiles when we have a non-zero signal; 0/0 often means
            counters never wired (auditor batch) — hide rather than fake data. */}
        {(s.linesAdded > 0 || s.linesRemoved > 0) ? (
          <>
            <Tile label="+ Lines" value={s.linesAdded} accent="text-emerald-300" zeroIsData />
            <Tile label="− Lines" value={s.linesRemoved} accent="text-rose-300" zeroIsData />
          </>
        ) : null}
        {s.totalTodos !== undefined ? <Tile label="Total todos" value={s.totalTodos} zeroIsData /> : null}
        {s.skippedTodos !== undefined ? <Tile label="Skipped todos" value={s.skippedTodos} zeroIsData /> : null}
        {s.staleEvents !== undefined ? <Tile label="Stale events" value={s.staleEvents} zeroIsData /> : null}
        <Tile label="Agents" value={s.agents.length} zeroIsData />
        {/* Task #163: run-level token totals. Computed accurately from
            tokenTracker.recent filtered by run window (independent of
            per-agent approximations). */}
        {s.totalPromptTokens !== undefined && s.totalPromptTokens > 0 ? (
          <Tile label="Tokens in" value={fmtTokensCompact(s.totalPromptTokens)} accent="text-sky-300" />
        ) : null}
        {s.totalResponseTokens !== undefined && s.totalResponseTokens > 0 ? (
          <Tile label="Tokens out" value={fmtTokensCompact(s.totalResponseTokens)} accent="text-violet-300" />
        ) : null}
      </div>
      {s.applyIntegrity ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <Tile
            label="Apply"
            value={`${s.applyIntegrity.applied}/${s.applyIntegrity.attempts}`}
            accent="text-sky-300"
          />
          {(s.applyIntegrity.missRecoveredDet ?? 0) > 0 ? (
            <Tile
              label="Recovered det"
              value={s.applyIntegrity.missRecoveredDet!}
              accent="text-emerald-300"
            />
          ) : null}
          {(s.applyIntegrity.missRecoveredLlm ?? 0) > 0 ? (
            <Tile
              label="Recovered llm"
              value={s.applyIntegrity.missRecoveredLlm!}
              accent="text-emerald-300"
            />
          ) : null}
          {(s.applyIntegrity.missTerminal ?? 0) > 0 ? (
            <Tile
              label="Terminal miss"
              value={s.applyIntegrity.missTerminal!}
              accent="text-rose-300"
            />
          ) : null}
          {s.applyIntegrity.repairSuccesses > 0 ? (
            <Tile label="Repair ✓" value={s.applyIntegrity.repairSuccesses} accent="text-emerald-300" />
          ) : null}
          {s.applyIntegrity.repairFailures > 0 ? (
            <Tile label="Repair ✗" value={s.applyIntegrity.repairFailures} accent="text-rose-300" />
          ) : null}
        </div>
      ) : null}
      {s.brainOs && s.brainOs.dispatches > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <Tile
            label="Brain OS"
            value={`${s.brainOs.resolved + s.brainOs.partial}/${s.brainOs.dispatches}`}
            accent="text-violet-300"
          />
          {s.brainOs.helpersSpawned > 0 ? (
            <Tile label="Helpers" value={s.brainOs.helpersSpawned} accent="text-violet-300" />
          ) : null}
          {s.brainOs.childDispatches > 0 ? (
            <Tile label="Child OS" value={s.brainOs.childDispatches} accent="text-fuchsia-300" />
          ) : null}
          {s.brainOs.blocked > 0 ? (
            <Tile label="OS blocked" value={s.brainOs.blocked} accent="text-amber-300" />
          ) : null}
          {s.brainOs.effectsApplied > 0 ? (
            <Tile label="Effects" value={s.brainOs.effectsApplied} accent="text-emerald-300" />
          ) : null}
        </div>
      ) : null}
      <AgentStatsTable
        label={`Per-agent (${s.agents.length})`}
        rows={rowsFromRunFinishedAgents(s.agents)}
      />
    </div>
  );
}

// Issue #2 (2026-04-27): per-stopReason palette so a 0-work
// no-progress run isn't rendered with the same emerald celebration as
// a true completed run. Default returns emerald (back-compat for old
// summaries that may carry an unknown stopReason value).
function paletteForStopReason(reason: string): { border: string; bg: string; title: string } {
  switch (reason) {
    case "completed":
      return {
        border: "border-emerald-700/50",
        bg: "bg-emerald-950/20",
        title: "text-emerald-300",
      };
    case "no-progress":
    case "cap:wall-clock":
    case "cap:commits":
    case "cap:todos":
    case "cap:tokens":
      return {
        border: "border-amber-700/50",
        bg: "bg-amber-950/20",
        title: "text-amber-300",
      };
    case "user":
      return {
        border: "border-ink-600/50",
        bg: "bg-ink-900/40",
        title: "text-ink-200",
      };
    case "crash":
    case "crashed":
    case "cap:quota":
      return {
        border: "border-rose-700/50",
        bg: "bg-rose-950/20",
        title: "text-rose-300",
      };
    case "early-stop":
    case "partial-progress":
      return {
        border: "border-sky-700/50",
        bg: "bg-sky-950/20",
        title: "text-sky-300",
      };
    default:
      return {
        border: "border-emerald-700/50",
        bg: "bg-emerald-950/20",
        title: "text-emerald-300",
      };
  }
}

// Task #72: grid renderer for the seed-announce system entry. The
// long top-level entries list collapses into a grid of pill chips
// instead of a comma-separated wall.
export function SeedAnnounceGrid({
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
    <div className="rounded border border-sky-700/40 bg-sky-950/20 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-sky-300 font-semibold tracking-wide text-xs uppercase">
          ⤓ Project seed
        </div>
        <div className="text-[10px] text-ink-500 font-mono">{tsStr}</div>
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs font-mono">
        <div className="text-ink-500">Repo</div>
        <div className="text-ink-200 break-all">
          <a href={s.repoUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200 underline">{s.repoUrl}</a>
        </div>
        <div className="text-ink-500">Clone</div>
        <div className="text-ink-200 break-all">{s.clonePath}</div>
        <div className="text-ink-500">Top-level</div>
        <div className="text-ink-200">{s.topLevel.length} entries</div>
      </div>
      <div className="flex flex-wrap gap-1">
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
      <div className="text-[10px] text-ink-500 italic">
        Use file-read / grep / find tools to inspect this repo — start with README.md if present.
      </div>
    </div>
  );
}

function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
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

function Tile({
  label,
  value,
  accent,
  /** When true, numeric 0 is a real measurement (commits/skipped/etc.), not "missing". */
  zeroIsData = false,
}: {
  label: string;
  value: number | string;
  accent?: string;
  zeroIsData?: boolean;
}) {
  // Only treat missing / undefined as empty. Legitimate zeros (0 commits,
  // 0 skipped) were rendering as "—" which made run summaries look blank
  // even when the run finished with structured counts.
  const isMissing =
    value === null
    || value === undefined
    || value === ""
    || (typeof value === "number" && !Number.isFinite(value));
  const isZero = typeof value === "number" && value === 0;
  const showDash = isMissing || (isZero && !zeroIsData);
  const display = showDash
    ? "—"
    : typeof value === "number"
      ? value.toLocaleString()
      : value;
  const colorClass = showDash
    ? "text-ink-400 opacity-50"
    : isZero && zeroIsData
      ? "text-ink-400"
      : (accent ?? "text-ink-100");
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono text-sm ${colorClass}`}>{display}</div>
    </div>
  );
}


