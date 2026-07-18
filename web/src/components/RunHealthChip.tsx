// Compact run-health chip: caps remaining, early-stop, drain eligibility,
// plus mid-run extend controls (uses /api/swarm/reconfig).

import { useState } from "react";
import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";
import { apiFetch } from "../lib/apiFetch";

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return `${Math.ceil(ms / 60_000)}m`;
}

/** Highest-count fail bucket for chip label (e.g. apply_miss). */
function topCycleFailBucket(
  failByBucket: Record<string, number> | undefined,
): string | null {
  if (!failByBucket) return null;
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of Object.entries(failByBucket)) {
    if (typeof v === "number" && v > n) {
      n = v;
      best = k;
    }
  }
  return best && n > 0 ? best : null;
}

function formatFailBuckets(
  failByBucket: Record<string, number> | undefined,
): string {
  if (!failByBucket) return "";
  const parts = Object.entries(failByBucket)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1]! - a[1]!)
    .slice(0, 5)
    .map(([k, v]) => `${k}:${v}`);
  return parts.length ? `buckets ${parts.join(",")}` : "";
}

export function RunHealthChip() {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const cfg = useSwarm((s) => s.runConfig);
  const caps = useSwarm((s) => s.capsRemaining);
  const progressHb = useSwarm((s) => s.progressHeartbeat);
  const cycleIntegrity = useSwarm((s) => s.cycleIntegrity);
  const applyIntegrity = useSwarm((s) => s.applyIntegrity);
  const researchIntegrity = useSwarm((s) => s.researchIntegrity);
  const early = useSwarm((s) => s.earlyStopDetail);
  const drainEligible = useSwarm((s) => s.drainEligible);
  const drainReason = useSwarm((s) => s.drainIneligibleReason);
  const pipelinePhase = useSwarm((s) => s.pipelinePhase);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const live = isActiveSwarmPhase(phase);
  if (!live && !early) return null;

  const parts: string[] = [];
  const wallCapMinRaw = cfg?.wallClockCapMin;
  const wallCapMin =
    wallCapMinRaw != null && wallCapMinRaw !== ""
      ? Number(wallCapMinRaw)
      : undefined;
  if (wallCapMin != null && Number.isFinite(wallCapMin)) {
    parts.push(`cap ${wallCapMin}m`);
  }
  if (cfg?.rounds != null) {
    parts.push(cfg.rounds === 0 ? "autonomous" : `${cfg.rounds} rounds`);
  }
  if (pipelinePhase?.preset) {
    parts.push(
      `pipe ${pipelinePhase.index}/${pipelinePhase.count} ${pipelinePhase.preset}`,
    );
  }
  if (caps?.wallClockMsRemaining != null) {
    parts.push(`left ${formatMs(caps.wallClockMsRemaining)}`);
  }
  if (caps?.tokenBudgetRemaining != null) {
    parts.push(`tok ${Math.round(caps.tokenBudgetRemaining / 1000)}k`);
  }
  if (drainEligible === false && drainReason) {
    parts.push("no-drain");
  } else if (drainEligible === true) {
    parts.push("drain-ok");
  }
  if (progressHb && live) {
    const quiet = progressHb.progressQuietMs;
    if (quiet >= 60_000) {
      parts.push(`progress quiet ${formatMs(quiet)}`);
    } else if (quiet >= 15_000) {
      parts.push(`progress ${formatMs(quiet)}`);
    }
  }
  if (cycleIntegrity && live) {
    const empty = cycleIntegrity.emptyExecutionCycles ?? 0;
    const streak = cycleIntegrity.lastEmptyStreak ?? 0;
    const fails = cycleIntegrity.todosFailed ?? 0;
    const topBucket = topCycleFailBucket(cycleIntegrity.failByBucket);
    if (streak >= 2) {
      parts.push(`empty×${streak}`);
    } else if (empty > 0 && empty >= 2) {
      parts.push(`empty ${empty}`);
    }
    if (fails > 0) {
      parts.push(topBucket ? `fails ${fails} (${topBucket})` : `fails ${fails}`);
    }
  }
  if (applyIntegrity && live && applyIntegrity.attempts > 0) {
    parts.push(`apply ${applyIntegrity.applied}/${applyIntegrity.attempts}`);
    const topMiss = topCycleFailBucket(applyIntegrity.missByKind);
    if (topMiss) parts.push(`miss ${topMiss}`);
    if ((applyIntegrity.missTerminal ?? 0) > 0) {
      parts.push(`term ${applyIntegrity.missTerminal}`);
    }
  }
  if (researchIntegrity && live) {
    if (researchIntegrity.blackoutActive || researchIntegrity.budgetExhausted) {
      parts.push("research BLACKOUT");
    } else if (researchIntegrity.searchAttempts > 0) {
      parts.push(
        `research ${researchIntegrity.searchSuccesses}/${researchIntegrity.searchAttempts}`,
      );
    }
    if (researchIntegrity.catalogInjects > 0) {
      parts.push(`catalog×${researchIntegrity.catalogInjects}`);
    }
  }
  if (early) {
    // Surface a short reason in the chip itself (not only the tooltip).
    const short =
      early.length > 28 ? `${early.slice(0, 26)}…` : early;
    parts.push(`stop:${short}`);
  }

  if (parts.length === 0 && !live) return null;

  const title = [
    wallCapMin != null && Number.isFinite(wallCapMin) ? `Wall-clock cap: ${wallCapMin} min` : null,
    cfg?.rounds != null ? `Rounds: ${cfg.rounds === 0 ? "autonomous (0)" : cfg.rounds}` : null,
    pipelinePhase
      ? `Pipeline phase ${pipelinePhase.index}/${pipelinePhase.count}: ${pipelinePhase.preset}${pipelinePhase.chain ? ` (${pipelinePhase.chain})` : ""}`
      : null,
    caps?.wallClockMsRemaining != null
      ? `Wall-clock remaining ≈ ${formatMs(caps.wallClockMsRemaining)}`
      : null,
    caps?.tokenBudgetRemaining != null
      ? `Token budget remaining ≈ ${caps.tokenBudgetRemaining.toLocaleString()}`
      : null,
    progressHb
      ? `Orchestration progress quiet ≈ ${formatMs(progressHb.progressQuietMs)} (since last durable apply/commit)`
      : null,
    cycleIntegrity
      ? [
          `Cycle integrity: empty=${cycleIntegrity.emptyExecutionCycles}`,
          `lastEmptyStreak=${cycleIntegrity.lastEmptyStreak}`,
          `todo fails=${cycleIntegrity.todosFailed}` +
            (cycleIntegrity.todosFailedUnique != null
              ? ` (${cycleIntegrity.todosFailedUnique} unique)`
              : ""),
          `ok=${cycleIntegrity.todosSucceeded}`,
          `cycles=${cycleIntegrity.cyclesCompleted}`,
          formatFailBuckets(cycleIntegrity.failByBucket),
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
    applyIntegrity && applyIntegrity.attempts > 0
      ? [
          `Apply integrity: ${applyIntegrity.applied}/${applyIntegrity.attempts} applied`,
          applyIntegrity.repairSuccesses > 0
            ? `repair✓${applyIntegrity.repairSuccesses}`
            : null,
          applyIntegrity.repairFailures > 0
            ? `repair✗${applyIntegrity.repairFailures}`
            : null,
          (applyIntegrity.missTerminal ?? 0) > 0
            ? `terminal ${applyIntegrity.missTerminal}`
            : null,
          formatFailBuckets(applyIntegrity.missByKind),
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
    researchIntegrity
      ? [
          `Research: ${researchIntegrity.searchSuccesses}/${researchIntegrity.searchAttempts} ok`,
          researchIntegrity.catalogInjects > 0
            ? `catalog×${researchIntegrity.catalogInjects}`
            : null,
          researchIntegrity.http403Count > 0
            ? `403×${researchIntegrity.http403Count}`
            : null,
          researchIntegrity.blackoutActive ? "BLACKOUT" : null,
          researchIntegrity.budgetExhausted ? "budget exhausted" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
    drainEligible === false ? `Drain: ${drainReason ?? "not eligible"}` : null,
    drainEligible === true ? "Drain: soft-stop available" : null,
    early ? `Early stop / guard: ${early}` : null,
    live ? "Use +15m / +2 rounds / +50k tok to extend mid-run (POST /api/swarm/reconfig)." : null,
  ]
    .filter(Boolean)
    .join("\n");

  const cycleStressed =
    !!cycleIntegrity
    && live
    && ((cycleIntegrity.lastEmptyStreak ?? 0) >= 2
      || (cycleIntegrity.todosFailed ?? 0) >= 3);
  const applyStressed =
    !!applyIntegrity
    && live
    && applyIntegrity.attempts > 0
    && ((applyIntegrity.missTerminal ?? 0) >= 2
      || (applyIntegrity.applied < applyIntegrity.attempts
        && applyIntegrity.attempts - applyIntegrity.applied >= 3));
  const researchStressed =
    !!researchIntegrity
    && live
    && (researchIntegrity.blackoutActive || researchIntegrity.budgetExhausted);
  const tone = early
    ? "border-amber-700/50 bg-amber-950/40 text-amber-200"
    : cycleStressed || applyStressed || researchStressed
      ? "border-amber-800/40 bg-amber-950/25 text-amber-100"
      : "border-ink-600 bg-ink-800/80 text-ink-300";

  async function reconfig(patch: Record<string, number>) {
    if (!runId || busy || !live) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch("/api/swarm/reconfig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, ...patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
      setMsg((body as { message?: string }).message ?? "updated");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border text-[10px] font-mono ${tone}`}
      title={title}
    >
      <span className="opacity-70">limits</span>
      <span>{parts.length > 0 ? parts.join(" · ") : "—"}</span>
      {live && runId ? (
        <span className="inline-flex items-center gap-0.5 ml-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconfig({ extendWallClockCapMin: 15 })}
            className="px-1 rounded border border-ink-600 hover:bg-ink-700/80 disabled:opacity-40"
            title="Extend wall-clock cap by 15 minutes"
          >
            +15m
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconfig({ extendRounds: 2 })}
            className="px-1 rounded border border-ink-600 hover:bg-ink-700/80 disabled:opacity-40"
            title="Add 2 rounds"
          >
            +2r
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconfig({ extendTokenBudget: 50_000 })}
            className="px-1 rounded border border-ink-600 hover:bg-ink-700/80 disabled:opacity-40"
            title="Add 50k token budget"
          >
            +50k
          </button>
        </span>
      ) : null}
      {msg ? <span className="text-sky-300/90 max-w-[10rem] truncate">{msg}</span> : null}
    </span>
  );
}
