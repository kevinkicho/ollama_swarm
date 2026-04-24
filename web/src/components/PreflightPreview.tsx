import { useEffect, useState } from "react";

// Preflight (2026-04-24): inline preview below the SetupForm's
// repoUrl + parentPath fields showing whether a Start click will:
//   - clone fresh (dest dir doesn't exist) → emerald
//   - resume on existing clone → blue, with prior-state counts
//   - be blocked because dest exists but isn't a git repo → amber
//
// Debounced at 400ms so typing doesn't thrash the backend. Silent
// on network error — keeps the form usable even if the dev server
// is momentarily unreachable (task #45/#47 style soft fallback).
interface PreflightState {
  destPath: string;
  exists: boolean;
  isGitRepo: boolean;
  alreadyPresent: boolean;
  priorCommits: number;
  priorChangedFiles: number;
  priorUntrackedFiles: number;
  blocker?: "not-git-repo";
}

export function PreflightPreview({
  repoUrl,
  parentPath,
}: {
  repoUrl: string;
  parentPath: string;
}) {
  const [state, setState] = useState<PreflightState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoUrl.trim() || !parentPath.trim()) {
      setState(null);
      setError(null);
      return;
    }
    // Debounce so we don't fire on every keystroke while the user
    // types out a URL.
    const t = setTimeout(() => {
      const params = new URLSearchParams({
        repoUrl: repoUrl.trim(),
        parentPath: parentPath.trim(),
      });
      // One retry on network error — same pattern as task #45/#47 for
      // tsx-watch restart windows. Keeps the preview responsive even
      // when the backend is briefly unreachable.
      (async () => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(`/api/swarm/preflight?${params.toString()}`);
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              setError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
              setState(null);
              return;
            }
            const body = (await res.json()) as PreflightState;
            setState(body);
            setError(null);
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
        // Silent on persistent network error — preview is best-effort.
        console.warn("preflight preview failed:", lastErr);
        setState(null);
        setError(null);
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [repoUrl, parentPath]);

  if (error) {
    return (
      <div className="rounded border border-rose-700/50 bg-rose-950/30 text-xs text-rose-200 p-3">
        <span className="font-semibold">Preflight error:</span> {error}
      </div>
    );
  }
  if (!state) return null;

  // Three possible states — render distinct colors so the signal is
  // immediate on a glance.

  if (state.blocker === "not-git-repo") {
    return (
      <div className="rounded border border-amber-700/50 bg-amber-950/30 text-xs text-amber-100 p-3 space-y-1">
        <div>
          <span className="text-amber-300 font-semibold uppercase tracking-wider text-[10px]">⚠ blocker</span>{" "}
          Target exists but is not a git repo.
        </div>
        <div className="font-mono text-amber-200/80 text-[11px] break-all">{state.destPath}</div>
        <div className="text-amber-200/70">
          Start will reject this path. Pick a different parent folder, or delete
          the existing directory first.
        </div>
      </div>
    );
  }

  if (state.alreadyPresent) {
    const bits: string[] = [];
    if (state.priorCommits > 0) {
      bits.push(
        `${state.priorCommits} prior commit${state.priorCommits === 1 ? "" : "s"}`,
      );
    }
    if (state.priorChangedFiles > 0) {
      bits.push(
        `${state.priorChangedFiles} modified file${state.priorChangedFiles === 1 ? "" : "s"}`,
      );
    }
    if (state.priorUntrackedFiles > 0) {
      bits.push(
        `${state.priorUntrackedFiles} untracked file${state.priorUntrackedFiles === 1 ? "" : "s"}`,
      );
    }
    const detail = bits.length > 0 ? bits.join(" · ") : "clean working tree";
    return (
      <div className="rounded border border-sky-700/50 bg-sky-950/30 text-xs text-sky-100 p-3 space-y-1">
        <div>
          <span className="text-sky-300 font-semibold uppercase tracking-wider text-[10px]">↻ resume</span>{" "}
          Found existing clone — will NOT re-clone.
        </div>
        <div className="font-mono text-sky-200/80 text-[11px] break-all">{state.destPath}</div>
        <div className="text-sky-200/90">{detail}</div>
      </div>
    );
  }

  // Fresh clone path — destination doesn't exist yet.
  return (
    <div className="rounded border border-emerald-700/50 bg-emerald-950/30 text-xs text-emerald-100 p-3 space-y-1">
      <div>
        <span className="text-emerald-300 font-semibold uppercase tracking-wider text-[10px]">+ fresh</span>{" "}
        Will clone fresh.
      </div>
      <div className="font-mono text-emerald-200/80 text-[11px] break-all">{state.destPath}</div>
    </div>
  );
}
