import { memo, useMemo } from "react";
import { useSwarm } from "../state/store";
import { isActiveSwarmPhase } from "../lib/swarmPhase";

/** Surfaces auditor-gated commits waiting for review so live runs don't
 *  look silently idle while workers poll "ready". */
export const AuditorGateBanner = memo(function AuditorGateBanner() {
  const todos = useSwarm((s) => s.todos);
  const phase = useSwarm((s) => s.phase);
  const agents = useSwarm((s) => s.agents);

  const pendingCommitCount = useMemo(
    () => Object.values(todos).filter((t) => t.status === "pending-commit").length,
    [todos],
  );

  const anyThinking = useMemo(
    () => Object.values(agents).some((a) => a.status === "thinking"),
    [agents],
  );

  if (!isActiveSwarmPhase(phase) || pendingCommitCount === 0) return null;

  return (
    <div className="px-4 py-1.5 bg-violet-950/50 border-b border-violet-700/40 flex items-center gap-2 text-xs">
      <span className="text-violet-300 font-mono">
        Auditor gate · {pendingCommitCount} pending commit
        {pendingCommitCount === 1 ? "" : "s"} awaiting review
      </span>
      {!anyThinking ? (
        <span className="text-violet-400/80">
          (workers idle — orchestrator should invoke auditor next)
        </span>
      ) : (
        <span className="text-violet-400/80">(workers finishing proposals…)</span>
      )}
    </div>
  );
});