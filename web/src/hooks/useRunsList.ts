import { useEffect, useState } from "react";
import type { RunSummaryDigest } from "../types";
import { apiFetch } from "../lib/apiFetch";

/**
 * Shared hook for the sidebar "Run Queue" + "System Metrics" + topbar stats.
 * Polls /api/swarm/runs (respects optional parentPath scoping).
 * Used so we don't have 3-4 independent 15-60s polls doing the same fs scan.
 */
export function useRunsList(parentPath?: string) {
  const [runs, setRuns] = useState<RunSummaryDigest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchRuns = async () => {
      try {
        const params = new URLSearchParams();
        if (parentPath) params.set("parentPath", parentPath);
        // Include other known parents so "runs" lists and sidebars see
        // yesterday's runs even without an active run in the exact parent.
        params.set("includeOtherParents", "true");
        const qs = params.toString();
        const res = await apiFetch(`/api/swarm/runs${qs ? `?${qs}` : ""}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data.runs) ? (data.runs as RunSummaryDigest[]) : [];
        if (!cancelled) {
          setRuns(list);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setRuns((prev) => prev); // keep last
          setLoading(false);
        }
      }
    };

    void fetchRuns();
    const interval = setInterval(fetchRuns, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [parentPath]);

  return { runs, loading };
}
