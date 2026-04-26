import { useSwarm } from "../state/store";
import { truncateLeft } from "./IdentityStrip";

// Unit 47: dismissible banner shown when the runner reuses an
// existing clone (build-on-existing-clone work pattern). Hides
// silently for fresh clones since "you started a fresh clone" isn't
// information the user needs to see — that's the default expectation.
export function CloneBanner() {
  const cloneState = useSwarm((s) => s.cloneState);
  const dismissed = useSwarm((s) => s.cloneBannerDismissed);
  const dismiss = useSwarm((s) => s.dismissCloneBanner);
  if (!cloneState || !cloneState.alreadyPresent || dismissed) return null;
  const { priorCommits, priorChangedFiles, priorUntrackedFiles, clonePath } = cloneState;
  const parts: string[] = [];
  if (priorCommits > 0) parts.push(`${priorCommits} prior commit${priorCommits === 1 ? "" : "s"}`);
  if (priorChangedFiles > 0) parts.push(`${priorChangedFiles} modified file${priorChangedFiles === 1 ? "" : "s"}`);
  if (priorUntrackedFiles > 0) parts.push(`${priorUntrackedFiles} untracked file${priorUntrackedFiles === 1 ? "" : "s"}`);
  const detail = parts.length > 0 ? parts.join(" · ") : "no working-tree changes";
  return (
    <div className="bg-blue-900/40 border-b border-blue-700/50 text-blue-100 text-sm px-4 py-2 flex items-center gap-3">
      <span className="text-blue-300 font-semibold">Resume:</span>
      <span className="flex-1">
        Building on an existing clone — {detail}.
        <span className="text-blue-300/70 font-mono ml-2 text-xs" title={clonePath}>
          {truncateLeft(clonePath, 60)}
        </span>
      </span>
      <button
        onClick={dismiss}
        className="text-blue-300 hover:text-blue-100 text-xs px-2 py-0.5 border border-blue-700/50 rounded hover:bg-blue-800/40"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
