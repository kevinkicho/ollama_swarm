import type { PerAgentStat } from "../types";
import { fmtMs, roleForRow } from "./runHistory";

/** Canonical per-agent stats row — one shape for transcript, sidebar, metrics, history. */
export interface AgentStatsRow {
  agentIndex: number;
  role: string;
  turns: number;
  attempts?: number | null;
  retries?: number | null;
  meanLatencyMs?: number | null;
  p50LatencyMs?: number | null;
  p95LatencyMs?: number | null;
  commits?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  rejected?: number | null;
  jsonRepairs?: number | null;
  promptErrors?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export function rowsFromPerAgentStats(
  agents: readonly PerAgentStat[],
  preset: string,
): AgentStatsRow[] {
  const n = agents.length;
  return agents.map((a) => ({
    agentIndex: a.agentIndex,
    role: roleForRow(preset, a.agentIndex, n),
    turns: a.turnsTaken,
    attempts: a.totalAttempts ?? null,
    retries: a.totalRetries ?? null,
    meanLatencyMs: a.meanLatencyMs ?? null,
    p50LatencyMs: a.p50LatencyMs ?? null,
    p95LatencyMs: a.p95LatencyMs ?? null,
    commits: a.commits ?? null,
    linesAdded: a.linesAdded ?? null,
    linesRemoved: a.linesRemoved ?? null,
    rejected: a.rejectedAttempts ?? null,
    jsonRepairs: a.jsonRepairs ?? null,
    promptErrors: a.promptErrors ?? null,
    tokensIn: a.tokensIn ?? null,
    tokensOut: a.tokensOut ?? null,
  }));
}

export function rowsFromRunFinishedAgents(
  agents: ReadonlyArray<{
    agentIndex: number;
    role: string;
    turns: number;
    attempts: number;
    retries: number;
    meanLatencyMs: number | null;
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    rejected: number;
    jsonRepairs: number;
    promptErrors: number;
    tokensIn?: number | null;
    tokensOut?: number | null;
  }>,
): AgentStatsRow[] {
  return agents.map((a) => ({
    agentIndex: a.agentIndex,
    role: a.role,
    turns: a.turns,
    attempts: a.attempts,
    retries: a.retries,
    meanLatencyMs: a.meanLatencyMs,
    commits: a.commits,
    linesAdded: a.linesAdded,
    linesRemoved: a.linesRemoved,
    rejected: a.rejected,
    jsonRepairs: a.jsonRepairs,
    promptErrors: a.promptErrors,
    tokensIn: a.tokensIn ?? null,
    tokensOut: a.tokensOut ?? null,
  }));
}

function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function NumOrDash({ value, className }: { value: number | null | undefined; className: string }) {
  const isEmpty = value == null || value === 0;
  if (isEmpty) return <td className={`${className} opacity-50`}>—</td>;
  return <td className={className}>{value.toLocaleString()}</td>;
}

export function AgentStatsTable({
  rows,
  label,
  className = "text-[11px]",
}: {
  rows: readonly AgentStatsRow[];
  label?: string;
  className?: string;
}) {
  if (rows.length === 0) return null;
  const showLatencyPercentiles = rows.some((r) => r.p50LatencyMs != null || r.p95LatencyMs != null);
  const showTokens = rows.some((r) => (r.tokensIn ?? 0) > 0 || (r.tokensOut ?? 0) > 0);

  return (
    <div>
      {label ? (
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
          {label}
        </div>
      ) : null}
      <div className="overflow-x-auto rounded border border-ink-700/60">
        <table className={`w-full font-mono ${className}`}>
          <thead className="bg-ink-800/60 text-ink-400 text-left">
            <tr>
              <th className="px-2 py-1">#</th>
              <th className="px-2 py-1">Role</th>
              <th className="px-2 py-1 text-right">Turns</th>
              <th className="px-2 py-1 text-right">Att</th>
              <th className="px-2 py-1 text-right">Ret</th>
              <th className="px-2 py-1 text-right">Mean</th>
              {showLatencyPercentiles ? (
                <>
                  <th className="px-2 py-1 text-right">p50</th>
                  <th className="px-2 py-1 text-right">p95</th>
                </>
              ) : null}
              <th className="px-2 py-1 text-right">Commits</th>
              <th className="px-2 py-1 text-right text-emerald-400/70">+L</th>
              <th className="px-2 py-1 text-right text-rose-400/70">−L</th>
              <th className="px-2 py-1 text-right text-rose-400/70">Rejected</th>
              <th className="px-2 py-1 text-right text-amber-400/70">JSON⚠</th>
              <th className="px-2 py-1 text-right text-rose-500/70">Errors</th>
              {showTokens ? (
                <>
                  <th className="px-2 py-1 text-right text-sky-400/70" title="Approximate for parallel runners">Tok in</th>
                  <th className="px-2 py-1 text-right text-violet-400/70" title="Approximate for parallel runners">Tok out</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.agentIndex} className="border-t border-ink-700/60">
                <td className="px-2 py-1 text-ink-300">{a.agentIndex}</td>
                <td className="px-2 py-1 text-ink-200">{a.role}</td>
                <td className="px-2 py-1 text-right text-ink-200">{a.turns}</td>
                <NumOrDash value={a.attempts} className="px-2 py-1 text-right text-ink-300" />
                <NumOrDash value={a.retries} className="px-2 py-1 text-right text-ink-300" />
                <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.meanLatencyMs ?? null)}</td>
                {showLatencyPercentiles ? (
                  <>
                    <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.p50LatencyMs ?? null)}</td>
                    <td className="px-2 py-1 text-right text-ink-300">{fmtMs(a.p95LatencyMs ?? null)}</td>
                  </>
                ) : null}
                <NumOrDash value={a.commits} className="px-2 py-1 text-right text-ink-200" />
                <NumOrDash value={a.linesAdded} className="px-2 py-1 text-right text-emerald-300" />
                <NumOrDash value={a.linesRemoved} className="px-2 py-1 text-right text-rose-300" />
                <NumOrDash
                  value={a.rejected}
                  className={`px-2 py-1 text-right ${(a.rejected ?? 0) > 0 ? "text-rose-300 font-semibold" : "text-ink-300"}`}
                />
                <NumOrDash
                  value={a.jsonRepairs}
                  className={`px-2 py-1 text-right ${(a.jsonRepairs ?? 0) > 0 ? "text-amber-300" : "text-ink-300"}`}
                />
                <NumOrDash
                  value={a.promptErrors}
                  className={`px-2 py-1 text-right ${(a.promptErrors ?? 0) > 0 ? "text-rose-400 font-semibold" : "text-ink-300"}`}
                />
                {showTokens ? (
                  <>
                    <td className={`px-2 py-1 text-right ${a.tokensIn != null && a.tokensIn > 0 ? "text-sky-300" : "text-ink-500 opacity-50"}`}>
                      {a.tokensIn != null ? fmtTokensCompact(a.tokensIn) : "—"}
                    </td>
                    <td className={`px-2 py-1 text-right ${a.tokensOut != null && a.tokensOut > 0 ? "text-violet-300" : "text-ink-500 opacity-50"}`}>
                      {a.tokensOut != null ? fmtTokensCompact(a.tokensOut) : "—"}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}