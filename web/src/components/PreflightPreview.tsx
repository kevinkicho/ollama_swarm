import type { PreflightState } from "../types";

// Preflight (2026-04-24): inline preview below the SetupForm's
// repoUrl + parentPath fields showing whether a Start click will:
//   - clone fresh (dest dir doesn't exist) → emerald
//   - resume on existing clone → blue, with prior-state counts
//   - be blocked because dest exists but isn't a git repo → amber
//
// 2026-05-03 (UX win #8): refactored to a presentational component.
// State + fetch logic moved to `usePreflight` hook; SetupForm owns
// the hook + passes results down so it can also use the state to
// drive the Start button label/disabled-ness without firing a
// duplicate fetch.

export function PreflightPreview({
  state,
  error,
}: {
  state: PreflightState | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded border border-rose-700/50 bg-rose-950/30 text-xs text-rose-200 p-3">
        <span className="font-semibold">Preflight error:</span> {error}
      </div>
    );
  }
  if (!state) return null;

  const providerBanner =
    state.providerWarnings && state.providerWarnings.length > 0 ? (
      <div className="rounded border border-amber-700/50 bg-amber-950/30 text-xs text-amber-100 p-3 space-y-1">
        <div className="text-amber-300 font-semibold uppercase tracking-wider text-[10px]">
          Missing API keys
        </div>
        <ul className="list-disc pl-4 space-y-0.5">
          {state.providerWarnings.map((w) => (
            <li key={`${w.provider}-${w.model}`}>{w.message}</li>
          ))}
        </ul>
      </div>
    ) : null;

  const probeBanner =
    state.providerProbeWarnings && state.providerProbeWarnings.length > 0 ? (
      <div className="rounded border border-rose-700/50 bg-rose-950/30 text-xs text-rose-100 p-3 space-y-1">
        <div className="text-rose-300 font-semibold uppercase tracking-wider text-[10px]">
          Provider health
        </div>
        <ul className="list-disc pl-4 space-y-0.5">
          {state.providerProbeWarnings.map((w) => (
            <li key={`probe-${w.provider}-${w.model}`}>
              <span className="font-mono text-rose-200/90">{w.model}</span>: {w.message}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  // Three possible states — render distinct colors so the signal is
  // immediate on a glance.

  if (state.blocker === "not-git-repo") {
    return (
      <div className="space-y-2">
      {providerBanner}
      {probeBanner}
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
      <div className="space-y-2">
      {providerBanner}
      {probeBanner}
      <div className="rounded border border-sky-700/50 bg-sky-950/30 text-xs text-sky-100 p-3 space-y-1">
        <div>
          <span className="text-sky-300 font-semibold uppercase tracking-wider text-[10px]">↻ resume</span>{" "}
          Found existing clone — will NOT re-clone.{" "}
          <span className="text-sky-200/70">
            (Start button below will say <strong className="text-sky-100">Resume run</strong> — clicking it confirms.)
          </span>
        </div>
        <div className="font-mono text-sky-200/80 text-[11px] break-all">{state.destPath}</div>
        <div className="text-sky-200/90">{detail}</div>
      </div>
      </div>
    );
  }

  // Fresh clone path — destination doesn't exist yet.
  return (
    <div className="space-y-2">
    {providerBanner}
    {probeBanner}
    <div className="rounded border border-emerald-700/50 bg-emerald-950/30 text-xs text-emerald-100 p-3 space-y-1">
      <div>
        <span className="text-emerald-300 font-semibold uppercase tracking-wider text-[10px]">+ fresh</span>{" "}
        Will clone fresh.
      </div>
      <div className="font-mono text-emerald-200/80 text-[11px] break-all">{state.destPath}</div>
    </div>
    </div>
  );
}
