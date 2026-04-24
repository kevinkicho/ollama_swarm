import type { PreflightState } from "../types";

// Start-confirmation modal (2026-04-24): signup-style gate fired when
// the user clicks Start and the preflight detects an existing clone
// OR a non-git-repo blocker at the target path. Keeps the choice
// visible + deliberate instead of silently resuming/resisting.
//
// Two scenarios → two modal variants:
//   - alreadyPresent=true  → [Resume (recommended)] / [Cancel]
//   - blocker="not-git-repo" → [Cancel] only (Start would reject anyway)
//
// Re-clone / force-delete is intentionally NOT offered from the UI
// per the 2026-04-24 design decision: deleting the user's agent-
// produced work from inside the app is too destructive; users who
// really want a fresh clone can delete the directory via File
// Explorer and hit Start again.
export function StartConfirmModal({
  state,
  onResume,
  onCancel,
}: {
  state: PreflightState;
  onResume: () => void;
  onCancel: () => void;
}) {
  const isBlocker = state.blocker === "not-git-repo";

  const statBits: string[] = [];
  if (state.priorCommits > 0) {
    statBits.push(`${state.priorCommits} prior commit${state.priorCommits === 1 ? "" : "s"}`);
  }
  if (state.priorChangedFiles > 0) {
    statBits.push(`${state.priorChangedFiles} modified file${state.priorChangedFiles === 1 ? "" : "s"}`);
  }
  if (state.priorUntrackedFiles > 0) {
    statBits.push(`${state.priorUntrackedFiles} untracked file${state.priorUntrackedFiles === 1 ? "" : "s"}`);
  }
  const stats = statBits.length > 0 ? statBits.join(" · ") : "clean working tree";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-ink-800 border border-ink-600 rounded-lg shadow-2xl p-6 space-y-4"
      >
        {isBlocker ? <BlockerBody destPath={state.destPath} /> : <ResumeBody destPath={state.destPath} stats={stats} />}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded bg-ink-700 hover:bg-ink-600 text-ink-200 border border-ink-600"
          >
            Cancel
          </button>
          {isBlocker ? null : (
            <button
              onClick={onResume}
              className="px-4 py-2 text-sm rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
            >
              Resume (recommended)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ResumeBody({ destPath, stats }: { destPath: string; stats: string }) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-sky-300 font-semibold mb-1">
          ↻ existing clone detected
        </div>
        <h3 className="text-lg font-semibold text-ink-100">
          A clone of this repo already exists at the target path.
        </h3>
      </div>
      <div className="rounded border border-sky-700/50 bg-sky-950/30 p-3 space-y-1 text-xs">
        <div className="font-mono text-sky-200/90 break-all">{destPath}</div>
        <div className="text-sky-200/80">{stats}</div>
      </div>
      <div className="text-sm text-ink-300 space-y-2">
        <p>
          Clicking <span className="text-emerald-300 font-medium">Resume</span> continues
          from this state — the planner sees any prior summaries + working-tree
          changes, and workers build on top. No re-clone, no data loss.
        </p>
        <p className="text-ink-400 text-xs">
          Want a fresh clone instead? <span className="text-ink-300">Cancel</span> this,
          delete <span className="font-mono text-ink-300">{basename(destPath)}</span> via File Explorer,
          and hit Start again.
        </p>
      </div>
    </>
  );
}

function BlockerBody({ destPath }: { destPath: string }) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold mb-1">
          ⚠ blocker
        </div>
        <h3 className="text-lg font-semibold text-ink-100">
          The target path exists but isn't a git repo.
        </h3>
      </div>
      <div className="rounded border border-amber-700/50 bg-amber-950/30 p-3 space-y-1 text-xs">
        <div className="font-mono text-amber-200/90 break-all">{destPath}</div>
      </div>
      <div className="text-sm text-ink-300 space-y-2">
        <p>
          Start would be rejected — the runner refuses to clone into a non-empty directory
          that isn't already a git repo (to avoid clobbering user content).
        </p>
        <p className="text-ink-400 text-xs">
          Pick a different Parent folder, or delete this directory via File Explorer
          and try again.
        </p>
      </div>
    </>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? p;
}
