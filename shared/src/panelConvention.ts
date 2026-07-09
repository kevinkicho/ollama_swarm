/** Panel path conventions and dedup for market-tab UI todos. */

export type MarketTab =
  | "fx"
  | "derivatives"
  | "equities"
  | "bonds"
  | "credit"
  | "insurance"
  | "real-estate"
  | "crypto";

const TAB_ALIASES: ReadonlyArray<{ tab: MarketTab; re: RegExp }> = [
  { tab: "bonds", re: /\bbonds?\b/i },
  { tab: "credit", re: /\bcredit\b/i },
  { tab: "fx", re: /\bfx\b|foreign exchange/i },
  { tab: "derivatives", re: /\bderivatives?\b/i },
  { tab: "equities", re: /\bequities\+?\b/i },
  { tab: "insurance", re: /\binsurance\b/i },
  { tab: "real-estate", re: /\breal[\s-]?estate\b/i },
  { tab: "crypto", re: /\bcrypto\b/i },
];

export function inferMarketTabFromText(text: string): MarketTab | undefined {
  for (const { tab, re } of TAB_ALIASES) {
    if (re.test(text)) return tab;
  }
  return undefined;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.split("/").pop() ?? norm;
}

function panelStem(pathOrName: string): string {
  const base = basename(pathOrName).replace(/\.(jsx|tsx)$/i, "");
  return base.replace(/panel$/i, "").toLowerCase();
}

export function isPanelComponentPath(path: string): boolean {
  return /Panel\.(jsx|tsx)$/i.test(path.replace(/\\/g, "/"));
}

export function isLegacyComponentsPanelPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return norm.startsWith("src/components/") && isPanelComponentPath(norm);
}

/** Preferred directory for new panel files in this repo layout. */
export function preferredPanelDirForTab(tab: MarketTab): string {
  return `src/markets/${tab}/`;
}

export function repathPanelToMarketTab(
  path: string,
  tab: MarketTab,
): string {
  const norm = path.replace(/\\/g, "/");
  const file = basename(norm);
  return `${preferredPanelDirForTab(tab)}${file}`;
}

export function repathPanelTestToMarketTab(
  path: string,
  tab: MarketTab,
): string {
  const norm = path.replace(/\\/g, "/");
  const file = basename(norm);
  const testDir = tab === "credit" ? "credit" : tab;
  return `src/__tests__/${testDir}/${file}`;
}

export interface PanelTodoInput {
  description: string;
  expectedFiles: string[];
}

export type PanelConventionOutcome =
  | { action: "unchanged" }
  | { action: "repath"; description: string; expectedFiles: string[]; note: string }
  | { action: "skip"; reason: string }
  | { action: "register-existing"; description: string; expectedFiles: string[]; note: string };

/** Find an existing panel file with a similar component stem (e.g. ImfFsi → ImfFsiCapitalAdequacy). */
export function findExistingSimilarPanel(
  proposedPanelPath: string,
  repoFiles: readonly string[],
): string | undefined {
  const proposedStem = panelStem(proposedPanelPath);
  if (proposedStem.length < 4) return undefined;

  let best: { path: string; score: number } | undefined;
  for (const f of repoFiles) {
    const norm = f.replace(/\\/g, "/");
    if (!isPanelComponentPath(norm)) continue;
    const stem = panelStem(norm);
    if (stem === proposedStem) return norm;
    const longer = stem.length >= proposedStem.length ? stem : proposedStem;
    const shorter = stem.length < proposedStem.length ? stem : proposedStem;
    if (longer.startsWith(shorter) && shorter.length >= 4) {
      const score = shorter.length;
      if (!best || score > best.score) best = { path: norm, score };
    }
  }
  return best?.path;
}

export function isCreatePanelTodo(description: string, expectedFiles: readonly string[]): boolean {
  if (!/create\s+.+\s*panel|panel component/i.test(description)) return false;
  return expectedFiles.some((f) => isPanelComponentPath(f));
}

/**
 * Enforce src/markets/{tab}/ layout, dedup near-miss panels, and skip redundant creates.
 */
export function applyPanelConvention(
  todo: PanelTodoInput,
  repoFiles: readonly string[],
): PanelConventionOutcome {
  const tab = inferMarketTabFromText(todo.description);
  const panelFiles = todo.expectedFiles.filter((f) => isPanelComponentPath(f));
  if (panelFiles.length === 0) return { action: "unchanged" };

  const primary = panelFiles[0]!;
  const similar = findExistingSimilarPanel(primary, repoFiles);
  if (similar && panelStem(similar) !== panelStem(primary)) {
    const panelName = basename(similar).replace(/\.(jsx|tsx)$/i, "");
    return {
      action: "register-existing",
      description: `Register existing ${panelName} in panelRegistry and the ${tab ?? "market"} tab (panel file already exists).`,
      expectedFiles: ["src/data/panelRegistry.js", similar].slice(0, 2),
      note: `Dedup: '${basename(primary)}' → existing '${similar}'`,
    };
  }

  if (!tab) return { action: "unchanged" };

  let changed = false;
  const nextFiles = todo.expectedFiles.map((f) => {
    const norm = f.replace(/\\/g, "/");
    if (isLegacyComponentsPanelPath(norm)) {
      changed = true;
      return repathPanelToMarketTab(norm, tab);
    }
    if (norm.startsWith("src/__tests__/") && isPanelComponentPath(norm)) {
      const repathed = repathPanelTestToMarketTab(norm, tab);
      if (repathed !== norm) {
        changed = true;
        return repathed;
      }
    }
    return f;
  });

  if (!changed) return { action: "unchanged" };

  let description = todo.description;
  if (!/src\/markets\//i.test(description)) {
    description = `${todo.description.replace(/\.$/, "")} in ${preferredPanelDirForTab(tab)}`;
  }

  return {
    action: "repath",
    description,
    expectedFiles: nextFiles,
    note: `Panel convention: repathed to ${preferredPanelDirForTab(tab)}`,
  };
}