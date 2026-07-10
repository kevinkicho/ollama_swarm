import { memo, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/apiFetch";

/**
 * Brain insights / follow-up proposals (librarian role).
 * Approve-to-provision: user must click "Approve & start" — auto-start is off by default.
 */

export interface BrainProposalRow {
  id: string;
  title: string;
  description: string;
  category?: string;
  priority?: string;
  status?: string;
  createdAt?: number;
}

export const BrainProposalsPanel = memo(function BrainProposalsPanel({
  clonePath,
}: {
  clonePath?: string;
}) {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<BrainProposalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/swarm/brain/proposals");
      const data = (await res.json()) as { proposals?: BrainProposalRow[] };
      const list = Array.isArray(data.proposals) ? data.proposals : [];
      // Prefer actionable follow-ups / recommendations that are still pending
      const sorted = [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      setProposals(sorted.slice(0, 12));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const approveAndStart = async (p: BrainProposalRow) => {
    if (!clonePath?.trim()) {
      setError("No workspace clone path — open a run or set parent workspace first.");
      return;
    }
    setBusyId(p.id);
    setError(null);
    try {
      const res = await apiFetch("/api/swarm/brain/provision", {
        method: "POST",
        body: JSON.stringify({
          proposalId: p.id,
          title: p.title,
          description: p.description,
          category: p.category,
          priority: p.priority ?? "medium",
          clonePath,
          approved: true,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        runId?: string;
        navigateTo?: string;
        error?: string;
      };
      if (!res.ok || !data.success || !data.runId) {
        setError(data.error || `Provision failed (HTTP ${res.status})`);
        return;
      }
      void load();
      navigate(data.navigateTo || `/runs/${encodeURIComponent(data.runId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (p: BrainProposalRow) => {
    setBusyId(p.id);
    setError(null);
    try {
      await apiFetch("/api/swarm/brain/reject", {
        method: "POST",
        body: JSON.stringify({
          proposalId: p.id,
          reason: "dismissed from UI",
          clonePath: clonePath || undefined,
        }),
      });
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const actionable = proposals.filter(
    (p) =>
      (p.status === "pending" || !p.status) &&
      (p.category === "followup" || p.category === "recommendation" || p.category === "research" || !p.category),
  );

  return (
    <div className="rounded border border-ink-700 bg-ink-900/50 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-400">
          Brain follow-ups
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-[9px] text-ink-500 hover:text-ink-300"
          title="Refresh"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      <p className="text-[9px] text-ink-500 leading-snug">
        Approve-to-provision: starts a new blackboard follow-up only when you click Approve.
      </p>
      {error && <div className="text-[9px] text-rose-400 break-words">{error}</div>}
      {!clonePath && (
        <div className="text-[9px] text-amber-500/90">Needs an active workspace path to start runs.</div>
      )}
      {actionable.length === 0 && !loading && (
        <div className="text-[9px] text-ink-500 italic">No pending follow-ups.</div>
      )}
      <ul className="space-y-1.5 max-h-48 overflow-y-auto">
        {actionable.map((p) => (
          <li
            key={p.id}
            className="rounded border border-ink-700/80 bg-ink-950/60 p-1.5 space-y-1"
          >
            <div className="text-[10px] font-medium text-ink-200 line-clamp-2">{p.title}</div>
            {p.description && (
              <div className="text-[9px] text-ink-500 line-clamp-2">{p.description}</div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {p.category && (
                <span className="text-[8px] uppercase text-violet-400/80">{p.category}</span>
              )}
              {p.priority && (
                <span className="text-[8px] text-ink-500">{p.priority}</span>
              )}
            </div>
            <div className="flex gap-1 pt-0.5">
              <button
                type="button"
                disabled={!clonePath || busyId === p.id}
                onClick={() => void approveAndStart(p)}
                className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/50 border border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/50 disabled:opacity-40"
              >
                {busyId === p.id ? "Starting…" : "Approve & start"}
              </button>
              <button
                type="button"
                disabled={busyId === p.id}
                onClick={() => void dismiss(p)}
                className="text-[9px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-400 hover:text-ink-200 disabled:opacity-40"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
});
