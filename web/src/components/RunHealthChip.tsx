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

export function RunHealthChip() {
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const cfg = useSwarm((s) => s.runConfig);
  const caps = useSwarm((s) => s.capsRemaining);
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
    drainEligible === false ? `Drain: ${drainReason ?? "not eligible"}` : null,
    drainEligible === true ? "Drain: soft-stop available" : null,
    early ? `Early stop / guard: ${early}` : null,
    live ? "Use +15m / +2 rounds / +50k tok to extend mid-run (POST /api/swarm/reconfig)." : null,
  ]
    .filter(Boolean)
    .join("\n");

  const tone = early
    ? "border-amber-700/50 bg-amber-950/40 text-amber-200"
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
