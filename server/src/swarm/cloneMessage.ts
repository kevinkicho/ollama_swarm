// Task #46 (UI-test feedback 2026-04-24): the seven runners all
// appended a "Cloned ${repoUrl} -> ${destPath}" system message to
// the transcript regardless of whether RepoService.clone actually
// cloned (fresh) or detected an existing clone and short-circuited
// (alreadyPresent: true). Kevin flagged this as misleading —
// "Cloned" on a resumed-run is a lie.
//
// This helper produces an honest message based on the CloneResult's
// alreadyPresent flag + prior-state stats. Shared across all runners
// so the wording stays consistent.

import type { CloneResult } from "../services/RepoService.js";

export function formatCloneMessage(
  repoUrl: string,
  destPath: string,
  result: CloneResult,
): string {
  if (!result.alreadyPresent) {
    return `Cloned ${repoUrl} -> ${destPath}`;
  }
  // Existing clone — build a short summary of what the runner is
  // resuming on. Omit zero-count stats to keep the line short.
  const bits: string[] = [];
  if (result.priorCommits > 0) {
    bits.push(`${result.priorCommits} prior commit${result.priorCommits === 1 ? "" : "s"}`);
  }
  if (result.priorChangedFiles > 0) {
    bits.push(`${result.priorChangedFiles} changed file${result.priorChangedFiles === 1 ? "" : "s"}`);
  }
  if (result.priorUntrackedFiles > 0) {
    bits.push(`${result.priorUntrackedFiles} untracked`);
  }
  const summary = bits.length > 0 ? ` (${bits.join(", ")})` : "";
  return `Resuming existing clone at ${destPath}${summary}`;
}
