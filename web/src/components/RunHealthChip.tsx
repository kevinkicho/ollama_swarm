// Compact run-health chip: caps remaining, early-stop, drain eligibility.

import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return `${Math.ceil(ms / 60_000)}m`;
}

export function RunHealthChip() {
  const phase = useSwarm((s) => s.phase);
  const caps = useSwarm((s) => s.capsRemaining);
  const early = useSwarm((s) => s.earlyStopDetail);
  const drainEligible = useSwarm((s) => s.drainEligible);
  const drainReason = useSwarm((s) => s.drainIneligibleReason);

  if (!isActiveSwarmPhase(phase) && !early) return null;

  const parts: string[] = [];
  if (caps?.wallClockMsRemaining != null) {
    parts.push(`⏱ ${formatMs(caps.wallClockMsRemaining)}`);
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
    parts.push("early-stop");
  }

  if (parts.length === 0) return null;

  const title = [
    caps?.wallClockMsRemaining != null
      ? `Wall-clock remaining ≈ ${formatMs(caps.wallClockMsRemaining)}`
      : null,
    caps?.tokenBudgetRemaining != null
      ? `Token budget remaining ≈ ${caps.tokenBudgetRemaining.toLocaleString()}`
      : null,
    drainEligible === false ? `Drain: ${drainReason ?? "not eligible"}` : null,
    drainEligible === true ? "Drain: eligible (soft stop preserves in-flight work)" : null,
    early ? `Early stop: ${early}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const tone = early
    ? "border-amber-700/50 bg-amber-950/40 text-amber-200"
    : "border-ink-600 bg-ink-800/80 text-ink-300";

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${tone}`}
      title={title}
    >
      <span className="opacity-70">health</span>
      <span>{parts.join(" · ")}</span>
    </span>
  );
}
