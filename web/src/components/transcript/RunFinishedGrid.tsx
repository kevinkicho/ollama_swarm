import { useState } from "react";
import type { TranscriptEntrySummary } from "../../types";

// Task #72 (2026-04-25): grid renderer for the end-of-run banner.
// Replaces the plaintext "═══ Run finished ═══" wall-of-text with a
// proper table — header strip with the headline stats, then a per-
// agent table with one row per agent and columns for every metric.
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
  return (
    <div className={`rounded border ${palette.border} ${palette.bg} p-3 my-2`}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className={`${palette.title} font-semibold tracking-wide text-xs uppercase`}>
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
    case "cap:quota":
      return {
        border: "border-rose-700/50",
        bg: "bg-rose-950/20",
        title: "text-rose-300",
      };
    case "early-stop":
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
