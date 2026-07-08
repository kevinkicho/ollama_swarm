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

export type RecentRunTipField = {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
};

/** Relative time for recent-run tooltips (deterministic `now` for tests). */
export function formatRecentRunAgo(startedAt: number, now = Date.now()): string {
  if (!startedAt || !Number.isFinite(startedAt)) return "—";
  const dt = now - startedAt;
  if (dt < 1000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Label/value rows for the recent-run chip hover tooltip. */
export function buildRecentRunTipFields(r: RecentRun): RecentRunTipField[] {
  const fields: RecentRunTipField[] = [
    { label: "preset", value: r.presetId?.trim() || "—", mono: true },
  ];
  if (r.repoUrl?.trim()) {
    fields.push({ label: "repo", value: shortRepoLabel(r.repoUrl.trim()), mono: true });
  }
  if (r.parentPath?.trim()) {
    fields.push({ label: "workspace", value: r.parentPath.trim(), mono: true });
  }
  const directive = r.directive?.trim() || r.directiveSnippet?.trim();
  if (directive) {
    fields.push({ label: "directive", value: directive, multiline: true });
  }
  fields.push({ label: "started", value: formatRecentRunAgo(r.startedAt), mono: true });
  if (r.runId?.trim()) {
    fields.push({ label: "run", value: r.runId.trim(), mono: true });
  }
  if (r.wallClockCapMin?.trim()) {
    fields.push({ label: "cap", value: `${r.wallClockCapMin.trim()} min`, mono: true });
  }
  if (r.ambitionTiers?.trim()) {
    fields.push({ label: "tiers", value: r.ambitionTiers.trim(), mono: true });
  }
  return fields;
}

/** Primary + optional preset labels for a recent-run chip (no separator dot). */
export function recentRunChipLabel(
  r: Pick<RecentRun, "repoUrl" | "parentPath" | "presetId">,
): { primary: string; preset?: string } {
  let primary = "";
  if (r.repoUrl?.trim()) {
    primary = shortRepoLabel(r.repoUrl.trim());
  }
  if (!primary && r.parentPath?.trim()) {
    const path = r.parentPath.trim().replace(/\\/g, "/").replace(/\/$/, "");
    primary = path.split("/").pop() ?? path;
  }
  if (!primary) primary = r.presetId || "run";
  const preset = r.presetId && primary !== r.presetId ? r.presetId : undefined;
  return preset ? { primary, preset } : { primary };
}
