// 2026-05-03 (UX win #7): localStorage-backed "recently used" list.
// Saves the last 3 successful start configurations so users
// iterating on the same project can re-fill the form with one click.
//
// Stored shape (JSON in localStorage):
//   { entries: RecentRun[] }
// Capped at 3 entries; older entries roll off the back.
//
// What's persisted: repoUrl, presetId, directive (truncated), parentPath.
// NOT persisted: per-preset advanced knobs (proposition, roles, etc.).
// Those reset to defaults on re-fill — keeps the surface tight.

const STORAGE_KEY = "ollama-swarm:recent-runs";
const MAX_ENTRIES = 3;
const MAX_DIRECTIVE_PREVIEW = 80;

export interface RecentRun {
  /** Stable identifier for this entry — used as React key. Currently
   *  a timestamp, but treat opaquely. */
  id: string;
  /** GitHub URL the user typed. */
  repoUrl: string;
  /** Parent folder path the user typed. */
  parentPath: string;
  /** Preset id (PresetId from server's enum, but stored as string here
   *  to avoid pulling the server type into the web layer). */
  presetId: string;
  /** Truncated directive snippet for the chip label. Empty string when
   *  no directive was set (e.g. analysis-only run). */
  directiveSnippet: string;
  /** Full untruncated directive — re-fills the textarea on click. */
  directive: string;
  /** Posix timestamp (ms) for sort + display ("2 min ago"). */
  startedAt: number;
  /** Persisted caps/tiers so refill restores the exact advanced settings. */
  wallClockCapMin?: string;
  ambitionTiers?: string;
  /** The runId returned by the server on successful start (full UUID).
   *  Used to load full summary and deep-link to /runs/:runId. */
  runId?: string;
}

export function loadRecentRuns(): RecentRun[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: RecentRun[] };
    if (!parsed.entries || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Push a new entry to the front; cap to MAX_ENTRIES; dedupe by
 *  (repoUrl + presetId) so back-to-back runs against the same target
 *  don't fill the list with duplicates. */
export function saveRecentRun(input: {
  repoUrl: string;
  parentPath: string;
  presetId: string;
  directive: string;
  wallClockCapMin?: string;
  ambitionTiers?: string;
  runId?: string;
}): RecentRun[] {
  try {
    const existing = loadRecentRuns();
    const directiveTrimmed = input.directive.trim();
    const snippet =
      directiveTrimmed.length > MAX_DIRECTIVE_PREVIEW
        ? `${directiveTrimmed.slice(0, MAX_DIRECTIVE_PREVIEW - 1)}…`
        : directiveTrimmed;
    const fresh: RecentRun = {
      id: String(Date.now()),
      repoUrl: input.repoUrl,
      parentPath: input.parentPath,
      presetId: input.presetId,
      directiveSnippet: snippet,
      directive: directiveTrimmed,
      startedAt: Date.now(),
      wallClockCapMin: input.wallClockCapMin,
      ambitionTiers: input.ambitionTiers,
      runId: input.runId,
    };
    // Dedupe: drop any prior entry with the same (repoUrl + presetId).
    const deduped = existing.filter(
      (e) => !(e.repoUrl === fresh.repoUrl && e.presetId === fresh.presetId),
    );
    const next = [fresh, ...deduped].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: next }));
    return next;
  } catch {
    return [];
  }
}

/** Strip the github.com prefix for the chip's repo label. */
export function shortRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}
