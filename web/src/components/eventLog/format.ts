import type { DerivedRunState } from "../../lib/eventLogUi";
import type { RunSliceSummary } from "./types";

export function displayPhase(d: DerivedRunState): string {
  let phase = d.finalPhase ?? "?";
  if (d.hasSummary && phase === "executing") phase = "completed";
  return phase;
}

export function phaseColor(phase: string): string {
  if (phase === "completed") return "text-emerald-300";
  if (phase === "failed") return "text-rose-300";
  if (phase === "stopped") return "text-amber-300";
  if (phase === "executing" || phase === "active") return "text-blue-300";
  if (phase === "archived") return "text-ink-400";
  return "text-ink-300";
}

export function canDrillDown(run: RunSliceSummary): boolean {
  return run.recordCount > 1;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function runKindBadge(
  run: RunSliceSummary,
  d: DerivedRunState,
): { label: string; className: string } {
  if (run.isSessionBoundary && !d.runId) {
    return { label: "sess", className: "bg-ink-700 text-ink-400" };
  }
  if (run.isSessionBoundary && d.runId) {
    return { label: "sess·run", className: "bg-amber-900/40 text-amber-300" };
  }
  return { label: "run", className: "bg-emerald-900/50 text-emerald-300" };
}

export function runSourceBadge(
  source: RunSliceSummary["source"],
): { label: string; className: string } | null {
  if (source === "per-run-debug") {
    return { label: "debug", className: "text-sky-300 bg-sky-950/40 border-sky-800/50" };
  }
  if (source === "archive-index") {
    return { label: "archive", className: "text-ink-400 bg-ink-900 border-ink-700" };
  }
  if (source === "global") {
    return { label: "live", className: "text-ink-400 bg-ink-900 border-ink-700" };
  }
  return null;
}

export function isEmptyGridPlaceholder(value: string | number): boolean {
  const s = String(value).trim();
  return s === "—" || s === "-" || s === "–" || s === "";
}
