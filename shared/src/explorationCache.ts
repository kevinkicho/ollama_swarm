/** Cross-phase planner explore brief — avoids redundant repo tours. */

export type ExplorationCachePhase =
  | "contract-explore"
  | "planner-todos-explore"
  | "council-shared-explore"
  | "tier-up"
  | "replan";

export interface ExplorationCacheEntry {
  phase: ExplorationCachePhase;
  /** Truncated model prose from the explore turn (thinking/tool markers stripped). */
  excerpt: string;
  agentId?: string;
  capturedAt: number;
}

/** Per-entry cap — keeps tier-up/replan prompts bounded. */
export const EXPLORATION_CACHE_ENTRY_MAX_CHARS = 12_000;

export function captureExplorationExcerpt(
  raw: string,
  maxChars = EXPLORATION_CACHE_ENTRY_MAX_CHARS,
): string {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 3) + "...";
}

export function appendExplorationCache(
  cache: ExplorationCacheEntry[] | undefined,
  entry: Omit<ExplorationCacheEntry, "capturedAt"> & { capturedAt?: number },
): ExplorationCacheEntry[] {
  const next: ExplorationCacheEntry = {
    ...entry,
    excerpt: captureExplorationExcerpt(entry.excerpt),
    capturedAt: entry.capturedAt ?? Date.now(),
  };
  const base = cache ?? [];
  const withoutDup = base.filter((e) => e.phase !== next.phase);
  return [...withoutDup, next];
}

export function hasExplorationCache(
  cache: ExplorationCacheEntry[] | undefined,
  phase: ExplorationCachePhase,
): boolean {
  return (cache ?? []).some((e) => e.phase === phase && e.excerpt.trim().length > 0);
}

export function getExplorationExcerpt(
  cache: ExplorationCacheEntry[] | undefined,
  phase: ExplorationCachePhase,
): string | undefined {
  const hit = (cache ?? []).find((e) => e.phase === phase);
  return hit?.excerpt?.trim() || undefined;
}

const PHASE_LABELS: Record<ExplorationCachePhase, string> = {
  "contract-explore": "Contract derivation explore",
  "planner-todos-explore": "Initial todos explore",
  "council-shared-explore": "Council shared explore",
  "tier-up": "Tier-up explore",
  replan: "Replanner explore",
};

export function buildExplorationCacheBlock(
  cache: ExplorationCacheEntry[] | undefined,
): string {
  const entries = (cache ?? []).filter((e) => e.excerpt.trim().length > 0);
  if (entries.length === 0) return "";
  const blocks = entries.map((e) => {
    const label = PHASE_LABELS[e.phase] ?? e.phase;
    const who = e.agentId ? ` (${e.agentId})` : "";
    return [
      `--- ${label}${who} ---`,
      e.excerpt.trim(),
      "",
    ].join("\n");
  });
  return [
    "=== PRIOR EXPLORE BRIEF (reuse — do NOT re-tour the repo) ===",
    "A prior planning phase already read/grepped key files. Prefer this evidence.",
    "Use tools only to verify one specific uncertainty (≤ a few calls).",
    "",
    ...blocks,
    "=== end PRIOR EXPLORE BRIEF ===",
    "",
  ].join("\n");
}

/** Todos phase can skip explore when contract explore already captured. */
export function shouldSkipTodosExplore(cache: ExplorationCacheEntry[] | undefined): boolean {
  return hasExplorationCache(cache, "contract-explore")
    || hasExplorationCache(cache, "council-shared-explore");
}