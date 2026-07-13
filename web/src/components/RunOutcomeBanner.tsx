import { memo } from "react";
import { useSwarm } from "../state/store";

/**
 * Surfaces stopReason + stopDetail after a run ends so quota walls,
 * audit-stuck, caps, and pipeline failures are not buried in the transcript.
 */
export const RunOutcomeBanner = memo(function RunOutcomeBanner() {
  const summary = useSwarm((s) => s.summary);
  const liveEarly = useSwarm((s) => s.earlyStopDetail);
  if (!summary?.stopReason && !liveEarly) return null;
  const reason = summary?.stopReason ?? "early-stop";
  const detail =
    (summary as { stopDetail?: string } | null | undefined)?.stopDetail ||
    (summary as { completionDetail?: string } | null | undefined)?.completionDetail ||
    liveEarly ||
    "";

  // Natural success / user stop — no banner (unless detail contradicts).
  if (
    (reason === "completed" || reason === "user")
    && !/no-progress|no-productive|audit-stuck|fail/i.test(detail)
  ) {
    return null;
  }

  const isQuota =
    reason === "cap:quota" ||
    /provider-quota|429|session usage|rate limit/i.test(detail) ||
    /provider-quota/i.test(String(reason));
  const isNoProgress =
    reason === "no-progress"
    || /audit-stuck|no-productive-progress|tier-stuck/i.test(detail);
  const reasonStr = String(reason);
  const isCrash = /crash|failed/i.test(reasonStr);
  const isWall =
    reason === "cap:wall-clock"
    || /wall.?clock/i.test(reasonStr)
    || /wall.?clock/i.test(detail);
  const isEarlyStop =
    reason === "early-stop"
    || reason.startsWith("cap:")
    || isWall
    || /pipeline phase|ambition-complete|planner-fallback|no-productive/i.test(
      detail,
    );

  // Any non-success stopReason is worth a banner (even without detail).
  if (
    !isQuota
    && !isNoProgress
    && !isCrash
    && !isEarlyStop
    && !detail
    && (reason === "completed" || reason === "user")
  ) {
    return null;
  }

  const tone = isQuota
    ? "border-amber-700/60 bg-amber-950/50 text-amber-100"
    : isCrash
      ? "border-rose-700/60 bg-rose-950/40 text-rose-100"
      : isNoProgress || isWall
        ? "border-amber-700/50 bg-amber-950/30 text-amber-100"
        : "border-ink-600 bg-ink-900/80 text-ink-200";

  const title = isQuota
    ? "Provider quota / transport wall"
    : isNoProgress
      ? "Stopped: no progress"
      : isWall
        ? "Stopped: wall-clock cap"
        : isCrash
          ? `Stopped: ${reason}`
          : isEarlyStop
            ? "Stopped early"
            : `Stopped: ${reason}`;

  return (
    <div className={`mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px] ${tone}`}>
      <div className="font-semibold">{title}</div>
      {detail && <div className="mt-0.5 opacity-90 break-words">{detail}</div>}
      {!detail && reason !== "completed" && reason !== "user" ? (
        <div className="mt-0.5 opacity-70">stopReason: {reason}</div>
      ) : null}
      {isQuota && (
        <div className="mt-1 text-[10px] opacity-80">
          Not a code deadlock — extend wall-clock / wait for quota, reconfig, or lower agentCount.
          Brain: <code className="text-[9px]">ollama-swarm reconfig --run-id … --extend-wall-clock-min 15</code>
        </div>
      )}
    </div>
  );
});
