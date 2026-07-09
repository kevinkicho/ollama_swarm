// Seed richness signals for planning fast paths (D12: direct emit from seed).

export interface PlanningSeedRichnessInput {
  endpointCatalogBlock?: string;
  codeContextExcerpts?: ReadonlyArray<{ path: string }>;
  projectGraphSlice?: string;
  explorationCache?: ReadonlyArray<{ excerpt: string }>;
  priorMemoryRendered?: string;
  priorDesignMemoryRendered?: string;
  userDirective?: string;
}

/** Count non-empty grounding blocks present in the planner seed. */
export function countSeedRichnessSignals(seed: PlanningSeedRichnessInput): number {
  let n = 0;
  if (seed.endpointCatalogBlock?.trim()) n++;
  if (seed.codeContextExcerpts && seed.codeContextExcerpts.length > 0) n++;
  if (seed.projectGraphSlice?.trim()) n++;
  if (seed.explorationCache?.some((e) => e.excerpt.trim().length > 0)) n++;
  if (seed.priorMemoryRendered?.trim()) n++;
  if (seed.priorDesignMemoryRendered?.trim()) n++;
  return n;
}

/**
 * D12: seed is rich enough to skip explore and emit structured JSON in one turn.
 * Requires planning fast path plus at least two grounding signals, or catalog + excerpts.
 */
export function isSeedSufficientForDirectEmit(
  seed: PlanningSeedRichnessInput,
  cfg?: { planningFastPath?: boolean },
): boolean {
  if (cfg?.planningFastPath !== true) return false;
  const signals = countSeedRichnessSignals(seed);
  const hasCatalog = !!(seed.endpointCatalogBlock?.trim());
  const hasExcerpts = !!(seed.codeContextExcerpts && seed.codeContextExcerpts.length > 0);
  if (hasCatalog && hasExcerpts) return true;
  return signals >= 2;
}