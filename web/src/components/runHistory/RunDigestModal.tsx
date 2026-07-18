import React, { useEffect, useMemo, useState } from "react";
import type { PerAgentStat, RunSummary, RunSummaryDigest } from "../../types";
import { copyText } from "../../utils/copyText";
import { truncateLeft } from "../IdentityStrip";
import { AgentStatsTable, rowsFromPerAgentStats } from "../AgentStatsTable";
import { apiFetch } from "../../lib/apiFetch";
import {
  cacheRunSummary,
  cachedRunSummary,
} from "./runHistoryCache";
import {
  fmtMs,
  formatRuntimeMs,
  roleForRow,
  TopologyChip,
  PresetChip,
  ResultChip,
} from "./runHistoryFormat";
import {
  snapshotFromRunSummary,
  stashPendingSetupSnapshot,
} from "../../lib/pendingSetupSnapshot";

export function RunDigestModal({ digest, onClose }: { digest: RunSummaryDigest; onClose: () => void }) {
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Task #111: track whether the loaded summary came from localStorage
  // (server unreachable) so the modal can show a "[cached]" badge.
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setFromCache(false);
      try {
        const params = new URLSearchParams({
          clonePath: digest.clonePath,
          ...(digest.runId ? { runId: digest.runId } : {}),
        });
        const r = await apiFetch(`/api/swarm/run-summary?${params.toString()}`);
        if (!r.ok) {
          if (r.status === 404) {
            // No full summary file yet (run in progress or very recent); fall back to digest info.
            if (!cancelled) setLoading(false);
            return;
          }
          // Task #111: HTTP-error fallback to cache (e.g. server up but
          // file missing — rarer case, but cache may still have it).
          if (!cancelled) {
            const cached = cachedRunSummary(digest.clonePath, digest.runId);
            if (cached) {
              setSummary(cached);
              setFromCache(true);
            } else {
              setError(`HTTP ${r.status}`);
            }
          }
          return;
        }
        const body = (await r.json()) as RunSummary;
        if (!cancelled) {
          setSummary(body);
          cacheRunSummary(digest.clonePath, digest.runId, body);
        }
      } catch (err) {
        // Task #111: network-error fallback to cache.
        if (!cancelled) {
          const cached = cachedRunSummary(digest.clonePath, digest.runId);
          if (cached) {
            setSummary(cached);
            setFromCache(true);
          } else {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digest.clonePath, digest.runId]);

  const summaryUrl = `/api/swarm/run-summary?clonePath=${encodeURIComponent(digest.clonePath)}${
    digest.runId ? `&runId=${encodeURIComponent(digest.runId)}` : ""
  }`;

  // Fall back to digest fields when the full summary fetch hasn't
  // landed yet — digest is a strict subset, so the header always
  // renders something useful.
  const head = summary ?? {
    repoUrl: "",
    localPath: digest.clonePath,
    preset: digest.preset,
    model: digest.model,
    startedAt: digest.startedAt,
    endedAt: digest.endedAt,
    wallClockMs: digest.wallClockMs,
    stopReason: (digest.stopReason ?? "") as RunSummary["stopReason"],
    commits: digest.commits,
    staleEvents: undefined as number | undefined,
    skippedTodos: undefined as number | undefined,
    totalTodos: digest.totalTodos,
    filesChanged: (digest as { filesChanged?: number }).filesChanged,
    finalGitStatus: "",
    finalGitStatusTruncated: false,
    agents: [] as PerAgentStat[],
  };

  /**
   * Counters coalesce summary + digest + topology/agentCount/board so the
   * modal never shows a blank strip when the digest had partial data, and
   * zeros display as 0 (not "—"). Undefined = field not recorded for this
   * preset (discussion often omits commits/todos).
   */
  const counters = useMemo(() => {
    const s = summary;
    const agentsArr = Array.isArray(s?.agents) ? s!.agents : [];
    const topoLen = s?.topology?.agents?.length ?? digest.topology?.agents?.length;
    const agentCount =
      agentsArr.length > 0
        ? agentsArr.length
        : s?.agentCount != null
          ? s.agentCount
          : topoLen != null
            ? topoLen
            : undefined;

    const board = (s as { board?: { committed?: number; skipped?: number; stale?: number; total?: number } } | null)
      ?.board;
    const v2q = s?.v2QueueState?.counts;

    const totalTodos =
      pickNum(s?.totalTodos)
      ?? pickNum(digest.totalTodos)
      ?? pickNum(board?.total)
      ?? pickNum(v2q?.total);

    const skippedTodos =
      pickNum(s?.skippedTodos)
      ?? pickNum(board?.skipped)
      ?? pickNum(v2q?.skipped);

    const staleEvents =
      pickNum(s?.staleEvents)
      ?? pickNum(board?.stale);

    const commits =
      pickNum(s?.commits)
      ?? pickNum(digest.commits)
      ?? pickNum(board?.committed)
      ?? pickNum(v2q?.completed);

    const filesChanged =
      pickNum(s?.filesChanged)
      ?? pickNum((digest as { filesChanged?: number }).filesChanged);

    return {
      commits,
      filesChanged,
      totalTodos,
      skippedTodos,
      staleEvents,
      agents: agentCount,
    };
  }, [summary, digest]);

  const goToSetupWithParams = (autoStart: boolean) => {
    const snap = snapshotFromRunSummary(digest, summary);
    stashPendingSetupSnapshot(snap);
    const params = new URLSearchParams();
    if (snap.parentPath) params.set("parentPath", snap.parentPath);
    if (snap.repoUrl) params.set("repoUrl", snap.repoUrl);
    if (snap.presetId) params.set("preset", snap.presetId);
    if (snap.model) params.set("model", snap.model);
    if (autoStart) params.set("autoStart", "1");
    // Full snapshot is in sessionStorage; query only helps cold hydrate.
    window.location.href = `/?${params.toString()}`;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 border border-ink-600 rounded-lg shadow-2xl w-[min(1400px,95vw)] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-ink-900 border-b border-ink-700 px-5 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-ink-100 truncate">{digest.name}</h3>
            <div className="text-[10px] font-mono text-ink-500 truncate flex items-center gap-2">
              <span>{digest.runId ? `run ${digest.runId}` : "(no runId)"}</span>
              {/* Task #111: cache badge when modal loaded from localStorage. */}
              {fromCache ? (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300"
                  title="Server unreachable — showing cached summary from localStorage."
                >
                  cached
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100 text-lg leading-none px-2"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Identity grid */}
          <section>
            <SectionLabel>Identity</SectionLabel>
            <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono">
              <DataLabel>Preset</DataLabel>
              <DataValue>{head.preset}</DataValue>
              <DataLabel>Model</DataLabel>
              <DataValue>{head.model}</DataValue>
              {head.repoUrl ? (
                <>
                  <DataLabel>Repo</DataLabel>
                  <DataValue>
                    <a
                      href={head.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-300 hover:text-sky-200 underline break-all"
                    >
                      {head.repoUrl}
                    </a>
                  </DataValue>
                </>
              ) : null}
              <DataLabel>Clone path</DataLabel>
              <DataValue><span className="break-all text-ink-300">{head.localPath}</span></DataValue>
              <DataLabel>Started</DataLabel>
              <DataValue>{new Date(head.startedAt).toLocaleString()}</DataValue>
              {head.endedAt > 0 ? (
                <>
                  <DataLabel>Ended</DataLabel>
                  <DataValue>{new Date(head.endedAt).toLocaleString()}</DataValue>
                </>
              ) : null}
              {head.wallClockMs > 0 ? (
                <>
                  <DataLabel>Wall-clock</DataLabel>
                  <DataValue>{formatRuntimeMs(head.wallClockMs)}</DataValue>
                </>
              ) : null}
              {head.stopReason ? (
                <>
                  <DataLabel>Stop reason</DataLabel>
                  <DataValue>{head.stopReason}</DataValue>
                </>
              ) : null}
              {summary?.streamIntegrity ? (
                <>
                  <DataLabel>Stream integrity</DataLabel>
                  <DataValue>
                    {summary.streamIntegrity.anomalyEventCount} event
                    {summary.streamIntegrity.anomalyEventCount === 1 ? "" : "s"}
                    {summary.streamIntegrity.hadLoopCollapse ? " · loop collapse" : ""}
                    {summary.streamIntegrity.hadHardTruncate ? " · hard truncate" : ""}
                    {summary.streamIntegrity.maxAgentTextChars > 0
                      ? ` · peak ${summary.streamIntegrity.maxAgentTextChars.toLocaleString()} chars`
                      : ""}
                  </DataValue>
                </>
              ) : null}
              {summary?.applyIntegrity ? (
                <>
                  <DataLabel>Apply integrity</DataLabel>
                  <DataValue>
                    {summary.applyIntegrity.applied}/{summary.applyIntegrity.attempts} applied
                    {summary.applyIntegrity.repairSuccesses > 0
                      ? ` · repair ✓${summary.applyIntegrity.repairSuccesses}`
                      : ""}
                    {summary.applyIntegrity.repairFailures > 0
                      ? ` · repair ✗${summary.applyIntegrity.repairFailures}`
                      : ""}
                    {(summary.applyIntegrity.missRecoveredDet ?? 0) > 0
                      ? ` · recovered det ${summary.applyIntegrity.missRecoveredDet}`
                      : ""}
                    {(summary.applyIntegrity.missRecoveredLlm ?? 0) > 0
                      ? ` · recovered llm ${summary.applyIntegrity.missRecoveredLlm}`
                      : ""}
                    {(summary.applyIntegrity.missTerminal ?? 0) > 0
                      ? ` · terminal miss ${summary.applyIntegrity.missTerminal}`
                      : ""}
                    {Object.keys(summary.applyIntegrity.missByKind ?? {}).length > 0
                      ? ` · misses: ${Object.entries(summary.applyIntegrity.missByKind)
                          .map(([k, n]) => `${k}=${n}`)
                          .join(", ")}`
                      : ""}
                  </DataValue>
                </>
              ) : null}
              {summary?.cycleIntegrity ? (
                <>
                  <DataLabel>Cycle integrity</DataLabel>
                  <DataValue>
                    {summary.cycleIntegrity.todosSucceeded}✓/{summary.cycleIntegrity.todosFailed}✗ todos
                    {summary.cycleIntegrity.emptyExecutionCycles > 0
                      ? ` · empty×${summary.cycleIntegrity.emptyExecutionCycles}`
                      : ""}
                    {summary.cycleIntegrity.maxEmptyStreak > 0
                      ? ` · max empty streak ${summary.cycleIntegrity.maxEmptyStreak}`
                      : ""}
                    {Object.keys(summary.cycleIntegrity.failByBucket ?? {}).length > 0
                      ? ` · ${Object.entries(summary.cycleIntegrity.failByBucket)
                          .map(([k, n]) => `${k}=${n}`)
                          .join(", ")}`
                      : ""}
                  </DataValue>
                </>
              ) : null}
              {summary?.researchIntegrity ? (
                <>
                  <DataLabel>Research integrity</DataLabel>
                  <DataValue>
                    {summary.researchIntegrity.searchSuccesses}/{summary.researchIntegrity.searchAttempts} ok
                    {summary.researchIntegrity.catalogInjects > 0
                      ? ` · catalog×${summary.researchIntegrity.catalogInjects}`
                      : ""}
                    {summary.researchIntegrity.http403Count > 0
                      ? ` · 403×${summary.researchIntegrity.http403Count}`
                      : ""}
                    {summary.researchIntegrity.blackoutActive ? " · BLACKOUT" : ""}
                    {summary.researchIntegrity.budgetExhausted ? " · budget exhausted" : ""}
                  </DataValue>
                </>
              ) : null}
            </div>
            {summary?.startCommand ? (
              <details className="mt-2 group">
                <summary className="text-[10px] text-ink-400 cursor-pointer hover:text-ink-200 select-none">
                  CLI command used to start this run
                </summary>
                <pre className="mt-1 p-2 rounded bg-ink-950 border border-ink-700 text-[10px] font-mono text-ink-300 overflow-x-auto whitespace-pre-wrap">
                  {summary.startCommand}
                </pre>
              </details>
            ) : null}
          </section>

          {/* Phase 4a of #243: full topology read-only grid. Shows the
              exact agent specs the run used (planner role, model overrides,
              etc.) so users can audit decisions after the fact. Falls
              back to "(no topology recorded)" for older summaries. */}
          {summary?.topology ? (
            <section>
              <SectionLabel>
                Topology — {summary.topology.agents.length}{" "}
                {summary.topology.agents.length === 1 ? "agent" : "agents"}
              </SectionLabel>
              <div className="rounded border border-ink-700 overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-ink-800/60 text-[9px] uppercase tracking-wider text-ink-500">
                    <tr>
                      <th className="px-2 py-1 text-left w-10">#</th>
                      <th className="px-2 py-1 text-left">Role</th>
                      <th className="px-2 py-1 text-left">Model</th>
                      <th className="px-2 py-1 text-left">Removable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topology.agents.map((a) => (
                      <tr key={a.index} className="border-t border-ink-800/60">
                        <td className="px-2 py-1 text-ink-400 font-mono">{a.index}</td>
                        <td className="px-2 py-1 text-ink-200">
                          {a.removable ? a.role : `🔒 ${a.role}`}
                        </td>
                        <td className="px-2 py-1 text-ink-300 font-mono">
                          {a.model ?? <span className="text-ink-600">(default)</span>}
                        </td>
                        <td className="px-2 py-1 text-ink-500">
                          {a.removable ? "yes" : "structural"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* Run-level counters — always shown (digest fallback while loading). */}
          <section>
            <SectionLabel>Counters</SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Commits" value={counters.commits} />
              <Stat label="Files changed" value={counters.filesChanged} />
              <Stat label="Total todos" value={counters.totalTodos} />
              <Stat label="Skipped todos" value={counters.skippedTodos} />
              <Stat label="Stale events" value={counters.staleEvents} />
              <Stat label="Agents" value={counters.agents} />
            </div>
            {!summary && !loading ? (
              <div className="text-[10px] text-ink-500 mt-1">
                Showing digest fields only — full summary not on disk.
              </div>
            ) : null}
            {summary && counters.commits == null && counters.totalTodos == null ? (
              <div className="text-[10px] text-ink-500 mt-1">
                Todo/commit counters are often omitted on discussion presets (e.g. council).
              </div>
            ) : null}
          </section>

          {/* Deliverables — created/modified file chips */}
          {summary && summary.deliverables && summary.deliverables.length > 0 ? (
            <section>
              <SectionLabel>Deliverables ({summary.deliverables.length})</SectionLabel>
              <div className="flex flex-wrap gap-1">
                {summary.deliverables.map((d) => (
                  <span
                    key={d.path}
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                      d.status === "created"
                        ? "bg-emerald-900/40 border-emerald-700/50 text-emerald-300"
                        : "bg-ink-700 border-ink-600 text-ink-300"
                    }`}
                  >
                    {d.path}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {/* Per-agent table */}
          {summary && summary.agents.length > 0 ? (
            <section>
              <AgentStatsTable
                label={`Per-agent (${summary.agents.length})`}
                rows={rowsFromPerAgentStats(summary.agents, summary.preset)}
              />
            </section>
          ) : null}

          {/* Contract criteria (blackboard only) */}
          {summary?.contract ? (
            <section>
              <SectionLabel>Contract — {summary.contract.criteria.length} criteria</SectionLabel>
              {summary.contract.missionStatement ? (
                <div className="text-ink-300 italic mb-1">{summary.contract.missionStatement}</div>
              ) : null}
              <ul className="space-y-1">
                {summary.contract.criteria.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span className={
                      c.status === "met" ? "text-emerald-400"
                      : c.status === "wont-do" ? "text-amber-400"
                      : "text-ink-500"
                    }>
                      {c.status === "met" ? "✓" : c.status === "wont-do" ? "✕" : "○"}
                    </span>
                    <span className="text-ink-300">{c.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* V2 reducer + queue state. Blackboard-only. After cutover
              Phase 1a (2026-04-28), the divergence-tracking chips +
              tables are gone — V2 events ran clean across 7/7 SDK
              presets and 4 V2 worker commits, so the parallel-track
              comparison was retired. The remaining display is a
              single-line snapshot of where V2 ended up. */}
          {summary?.v2State || summary?.v2QueueState ? (
            <section>
              <SectionLabel>V2 final state</SectionLabel>
              <div className="flex flex-wrap items-baseline gap-2 text-[11px]">
                {summary.v2State ? (
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider bg-emerald-900/60 text-emerald-200">
                    phase: {summary.v2State.phase}
                  </span>
                ) : null}
                {summary.v2QueueState ? (
                  <span className="px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-wider bg-emerald-900/60 text-emerald-200">
                    queue: {summary.v2QueueState.counts.completed}/{summary.v2QueueState.counts.total}
                  </span>
                ) : null}
                {summary.v2State?.pausedReason ? (
                  <span className="text-amber-300 text-[10px]">paused: {summary.v2State.pausedReason}</span>
                ) : null}
                {summary.v2State?.detail ? (
                  <span className="text-ink-400 text-[10px]">{summary.v2State.detail}</span>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Final git status */}
          {summary?.finalGitStatus ? (
            <section>
              <SectionLabel>
                Final git status
                {summary.finalGitStatusTruncated ? <span className="text-amber-400"> (truncated)</span> : null}
              </SectionLabel>
              <pre className="text-[10px] font-mono text-ink-400 bg-ink-950/60 border border-ink-700 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                {summary.finalGitStatus.trim() || "(clean)"}
              </pre>
            </section>
          ) : null}

          {/* Loading / error state */}
          {loading ? (
            <div className="text-ink-500 italic">Loading full summary…</div>
          ) : null}
          {error && !summary ? (
            <div className="text-rose-300">Failed to load full summary: {error}</div>
          ) : null}
          {!loading && !error && !summary ? (
            <div className="text-ink-500 italic">
              No matching summary on disk. Showing digest only.
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-ink-900 border-t border-ink-700 px-5 py-3 flex flex-wrap justify-end gap-2">
          {/* Task #65: open the run in a fresh tab as if it were live —
              new tab parses ?review + ?path, hydrates store from the
              saved summary, and reuses SwarmView's existing panels
              (transcript / metrics / agent cards). Disabled when the
              summary has no transcript (legacy runs predate task #65). */}
          {digest.runId ? (
            <a
              href={`/?review=${encodeURIComponent(digest.runId)}&path=${encodeURIComponent(digest.clonePath)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={summary?.transcript
                ? `Replay this run in a new tab (${summary.transcript.length} transcript entries)`
                : "Open the run in a new tab — transcript replay only works on runs after task #65 landed"}
              className="text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 border border-emerald-600 font-medium"
            >
              Open run review ↗
            </a>
          ) : null}
          <a
            href={summaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open summary JSON ↗
          </a>
          <button
            onClick={() => {
              void apiFetch("/api/swarm/open", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: digest.clonePath }),
              }).catch(() => {});
            }}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Open folder
          </button>
          <button
            onClick={() => goToSetupWithParams(false)}
            className="text-xs px-3 py-1.5 rounded bg-sky-800 hover:bg-sky-700 text-sky-100 border border-sky-600"
            title="Open Start page and fill form from this run (topology, models, directive, MCP when recorded)"
          >
            Load params on Start page
          </button>
          <button
            onClick={() => goToSetupWithParams(true)}
            className="text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100 border border-emerald-600"
            title="Start a new swarm reusing this clone, with form params restored from the summary"
          >
            Start new swarm on this clone
          </button>
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
      {children}
    </div>
  );
}

function DataLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-500">{children}</div>;
}

function DataValue({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-200 min-w-0">{children}</div>;
}

// 2026-04-25 fine-tune (Kevin): per-agent table cells render zero/null
// values as "—" at opacity-50 (matches dropdown + headline-tile
// convention). Reuses the caller's className for padding/alignment,
// adds opacity-50 when empty.
function NumOrDashCell({ value, className }: { value: number | null | undefined; className: string }) {
  const isEmpty = !value;
  if (isEmpty) {
    return <td className={`${className} opacity-50`}>—</td>;
  }
  return <td className={className}>{value.toLocaleString()}</td>;
}

/** Prefer a finite number; treat null/undefined/NaN as missing. */
function pickNum(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  // 0 is a real measurement (e.g. filesChanged: 0). Only undefined/null → "—".
  const isMissing = value == null || !Number.isFinite(value);
  const display = isMissing ? "—" : value.toLocaleString();
  return (
    <div className="rounded border border-ink-700 bg-ink-950/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono text-sm min-h-[1.25rem] ${isMissing ? "text-ink-400 opacity-50" : "text-ink-100"}`}>
        {display}
      </div>
    </div>
  );
}
