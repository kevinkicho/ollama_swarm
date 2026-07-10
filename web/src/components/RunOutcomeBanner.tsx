import { memo } from "react";
import { useSwarm } from "../state/store";

/**
 * Surfaces stopReason + stopDetail after a run ends so quota walls and
 * audit-stuck are not confused.
 */
export const RunOutcomeBanner = memo(function RunOutcomeBanner() {
  const summary = useSwarm((s) => s.summary);
  if (!summary?.stopReason) return null;
  const reason = summary.stopReason;
  const detail =
    (summary as { stopDetail?: string }).stopDetail ||
    (summary as { completionDetail?: string }).completionDetail ||
    "";
  const isQuota =
    reason === "cap:quota" ||
    /provider-quota|429|session usage|rate limit/i.test(detail) ||
    /provider-quota/i.test(String(reason));
  const isNoProgress = reason === "no-progress" || /audit-stuck/i.test(detail);

  const isCrash = reason === "crash" || reason === "crashed";
  if (!isQuota && !isNoProgress && !isCrash) {
    return null;
  }

  const tone = isQuota
    ? "border-amber-700/60 bg-amber-950/50 text-amber-100"
    : isCrash
      ? "border-rose-700/60 bg-rose-950/40 text-rose-100"
      : "border-ink-600 bg-ink-900/80 text-ink-200";

  const title = isQuota
    ? "Provider quota / transport wall"
    : isNoProgress
      ? "Stopped: no progress"
      : `Stopped: ${reason}`;

  return (
    <div className={`mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px] ${tone}`}>
      <div className="font-semibold">{title}</div>
      {detail && <div className="mt-0.5 opacity-90 break-words">{detail}</div>}
      {isQuota && (
        <div className="mt-1 text-[10px] opacity-80">
          Not a code deadlock — extend wall-clock / wait for quota, reconfig, or lower agentCount.
          Brain: <code className="text-[9px]">ollama-swarm reconfig --run-id … --extend-wall-clock-min 15</code>
        </div>
      )}
    </div>
  );
});
