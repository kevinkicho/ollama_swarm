// Shared seed grounding blocks for planner / contract / council-merge prompts.
// Keeps contract derivation aligned with the richer todos prompt (endpoint
// catalog, prefetched excerpts, project graph, memory).

import { getModelBudget } from "../../modelContextBudget.js";
import { buildExplorationCacheBlock } from "@ollama-swarm/shared/explorationCache";
import type { PlannerSeed } from "./planner.js";
import {
  buildResearchNotesBlock,
  buildResearchToolsNote,
  PRIOR_RATIONALE_MAX_CHARS,
} from "./planner.js";
import type { PriorRunSummary } from "./planner.js";

export interface PlannerGroundingBlocks {
  /** Design + project graph + memory + endpoint catalog + excerpts + system map. */
  prefix: string;
  readme: string;
  codeContextBlock: string;
  researchToolsNote: string;
  researchNotesBlock: string;
}

function buildPriorRunBlock(prior: PriorRunSummary | undefined): string {
  if (!prior) return "";
  const truncate = (s: string | undefined): string => {
    if (!s) return "";
    const t = s.trim();
    return t.length <= PRIOR_RATIONALE_MAX_CHARS ? t : t.slice(0, PRIOR_RATIONALE_MAX_CHARS - 3) + "...";
  };
  const criteriaLines = prior.criteria.map((c) => {
    const r = truncate(c.rationale);
    const filesPart =
      c.expectedFiles.length > 0 ? ` (files: ${c.expectedFiles.join(", ")})` : "";
    return `  - [${c.id}] (${c.status}) ${c.description}${r ? ` — ${r}` : ""}${filesPart}`;
  });
  return [
    `=== PRIOR RUN (Unit 50 — RESUME on this same clone, see Rule 12) ===`,
    `Prior mission (${prior.startedAtIso}): ${prior.missionStatement}`,
    `Prior criteria (${prior.criteria.length}):`,
    ...criteriaLines,
    `=== end PRIOR RUN ===`,
    "",
  ].join("\n");
}

/** Seed-first guidance when rich grounding blocks are present in the user message. */
export function buildSeedFirstToolGuidance(seed: PlannerSeed): string {
  const hasCatalog = !!(seed.endpointCatalogBlock && seed.endpointCatalogBlock.trim().length > 0);
  const hasExcerpts = !!(seed.codeContextExcerpts && seed.codeContextExcerpts.length > 0);
  const hasGraph = !!(seed.projectGraphSlice && seed.projectGraphSlice.trim().length > 0);
  const hasExploreCache = !!(seed.explorationCache && seed.explorationCache.length > 0);
  const hasTabs = !!(seed.tabInventoryBlock && seed.tabInventoryBlock.trim().length > 0);
  if (
    !hasCatalog
    && !hasExcerpts
    && !hasGraph
    && !hasExploreCache
    && !hasTabs
    && !seed.priorMemoryRendered
    && !seed.priorDesignMemoryRendered
  ) {
    return "";
  }
  const lines = [
    "SEED-FIRST (planning fast path): The user message already includes repo grounding",
    "(file list, README, and any blocks below). Prefer that evidence when drafting output.",
  ];
  if (hasCatalog) lines.push("- ENDPOINT CATALOG is authoritative for API routes — do NOT web_search for routes already listed.");
  if (hasExcerpts) lines.push("- PRE-FETCHED EXCERPTS show real file heads — cite these before opening more files.");
  if (hasGraph) lines.push("- PROJECT MAP summarizes cross-run structure — use it before broad directory walks.");
  if (hasTabs) {
    lines.push(
      "- DISK TAB INVENTORY lists existing tab titles — do NOT invent todos for topics already listed; only new topics.",
    );
  }
  if (hasExploreCache) {
    lines.push("- PRIOR EXPLORE BRIEF captures an earlier repo tour — reuse it; do NOT repeat broad scans.");
  }
  lines.push(
    "Use read/grep/glob/list only to verify a specific uncertainty (≤ a few calls).",
    "Do NOT re-scan the whole repository when the seed already answers the question.",
    "",
  );
  return lines.join("\n");
}

/** Brief for council/contract emit when seed grounding replaces an explore turn (D12). */
export function buildSeedDirectEmitBrief(seed: PlannerSeed): string {
  const guidance = buildSeedFirstToolGuidance(seed);
  return [
    "SEED-DIRECT EMIT: Repository grounding in this message is sufficient.",
    "Do NOT call read/grep/glob/list/bash/web tools — emit structured JSON from the seed below.",
    guidance.trim() || "Use USER DIRECTIVE + prefetched blocks as primary evidence.",
    "",
  ].join("\n");
}

export function buildPlannerGroundingBlocks(seed: PlannerSeed, model?: string): PlannerGroundingBlocks {
  const budget = getModelBudget(model);
  const readme = seed.readmeExcerpt
    ? seed.readmeExcerpt.slice(0, budget.fullFileMode ? 20_000 : 4_000)
    : "(no README found at repo root)";

  const memoryBlock = seed.priorMemoryRendered ? `${seed.priorMemoryRendered}\n\n` : "";
  const designBlock = seed.priorDesignMemoryRendered
    ? `${seed.priorDesignMemoryRendered}\n\n` +
      "GUIDANCE: honor the north star + recent decisions when planning. Prefer work that advances the roadmap.\n\n"
    : "";
  const projectGraphBlock = seed.projectGraphSlice ? `${seed.projectGraphSlice}\n\n` : "";
  const userChatBlock =
    seed.userChatBlock && seed.userChatBlock.trim().length > 0
      ? `${seed.userChatBlock.trim()}\n\n`
      : "";
  const endpointCatalogBlock =
    seed.endpointCatalogBlock && seed.endpointCatalogBlock.trim().length > 0
      ? `${seed.endpointCatalogBlock.trim()}\n\n`
      : "";
  const priorBlock = buildPriorRunBlock(seed.priorRunSummary);

  const codeContextBlock =
    seed.codeContextExcerpts && seed.codeContextExcerpts.length > 0
      ? [
          "=== PRE-FETCHED FILE EXCERPTS (head only, picked from directive keywords + repo structure) ===",
          ...seed.codeContextExcerpts.flatMap((f) => [
            `--- ${f.path} ---`,
            f.excerpt,
            "",
          ]),
          "=== end PRE-FETCHED EXCERPTS ===",
          "",
        ].join("\n")
      : "";

  const systemMapBlock = seed.systemMap
    ? `=== SYSTEM MAP (lightweight broad view for systemic planning) ===\n${seed.systemMap}\n=== end SYSTEM MAP ===\n\n`
    : "";

  const explorationCacheBlock = buildExplorationCacheBlock(seed.explorationCache);
  const tabInventoryBlock =
    seed.tabInventoryBlock && seed.tabInventoryBlock.trim().length > 0
      ? `${seed.tabInventoryBlock.trim()}\n\n` +
        "GUIDANCE: only plan NEW tab topics not already listed; skip or mark met work that is already on disk.\n\n"
      : "";

  const prefix =
    designBlock +
    projectGraphBlock +
    memoryBlock +
    priorBlock +
    userChatBlock +
    endpointCatalogBlock +
    tabInventoryBlock +
    explorationCacheBlock +
    systemMapBlock +
    buildSeedFirstToolGuidance(seed);

  return {
    prefix,
    readme,
    codeContextBlock,
    researchToolsNote: buildResearchToolsNote(!!seed.webToolsEnabled),
    researchNotesBlock: buildResearchNotesBlock(seed.researchNotes),
  };
}