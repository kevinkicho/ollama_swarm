// 2026-05-03 (UX win #8): shared preflight hook. Lifts what
// PreflightPreview owned internally so SetupForm can also read the
// state to drive the Start button's label + disabled-ness.
//
// Pre-fix: SetupForm fired its OWN preflight inside onSubmit, then
// showed StartConfirmModal as a focus-grabbing confirmation step
// duplicating what PreflightPreview already showed inline. With this
// hook, both consumers share one preflight result; SetupForm uses it
// to label Start as "Resume run" / "Start swarm" and to disable on
// blocker. Modal goes away.
//
// Debounced 400ms to match PreflightPreview's prior behavior so
// typing doesn't thrash the backend. One retry on network error
// (tsx-watch restart window) — same soft-fallback as task #45/#47.

import { useEffect, useState } from "react";
import type { PreflightState } from "../types";

export interface UsePreflightResult {
  state: PreflightState | null;
  error: string | null;
  /** True while the debounce timer is active (i.e., user is still
   *  typing) OR a fetch is in flight. Lets the caller distinguish
   *  "no result yet, wait" from "got result, render". */
  loading: boolean;
}

export interface PreflightModelParams {
  model?: string;
  plannerModel?: string;
  workerModel?: string;
  auditorModel?: string;
}

export function usePreflight(
  repoUrl: string,
  parentPath: string,
  models: PreflightModelParams = {},
): UsePreflightResult {
  const [state, setState] = useState<PreflightState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!parentPath.trim()) {
      setState(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({
        repoUrl: repoUrl.trim() || "",
        parentPath: parentPath.trim(),
      });
      for (const [key, value] of Object.entries(models)) {
        const v = value?.trim();
        if (v) params.set(key, v);
      }
      let cancelled = false;
      (async () => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(`/api/swarm/preflight?${params.toString()}`);
            if (cancelled) return;
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              setError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
              setState(null);
              setLoading(false);
              return;
            }
            const body = (await res.json()) as PreflightState;
            setState(body);
            setError(null);
            setLoading(false);
            return;
          } catch (err) {
            lastErr = err;
            if (err instanceof TypeError && attempt === 0) {
              await new Promise((r) => setTimeout(r, 400));
              continue;
            }
            break;
          }
        }
        if (cancelled) return;
        // Silent on persistent network error — preview is best-effort.
        // Match the prior PreflightPreview behavior: log to console + clear state.
        console.warn("preflight failed:", lastErr);
        setState(null);
        setError(null);
        setLoading(false);
      })();
      return () => { cancelled = true; };
    }, 400);
    return () => {
      clearTimeout(t);
      setLoading(false);
    };
  }, [repoUrl, parentPath, models.model, models.plannerModel, models.workerModel, models.auditorModel]);

  return { state, error, loading };
}
