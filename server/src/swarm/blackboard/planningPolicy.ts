// Planning-phase policy: goal pre-pass gating, wall-clock cap, contract profile.

import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { ParsedContract } from "./prompts/firstPassContract.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { resolveToolProfile } from "../toolProfiles.js";
import { PLANNING_WALL_CLOCK_CAP_MS } from "./BlackboardRunnerConstants.js";

/** Directives at or above this length are treated as user-supplied plans (skip goal pre-pass). */
export const SUBSTANTIAL_DIRECTIVE_MIN_CHARS = 80;

/** Presets that never use blackboard planning fast path (Phase 5 opt-out). */
export const PLANNING_FAST_PATH_EXCLUDED_PRESETS = new Set<string>([
  "stigmergy",
  "map-reduce",
]);

/** Phase 5: honor planningFastPath only on presets that use blackboard planning. */
export function resolvePlanningFastPath(cfg: RunConfig | undefined): boolean {
  if (!cfg) return false;
  if (PLANNING_FAST_PATH_EXCLUDED_PRESETS.has(cfg.preset)) return false;
  return cfg.planningFastPath === true;
}

const SCOPED_UI_KEYWORD = /\b(ui|ux|component|tooltip|banner|button|modal|panel|tab|tsx|jsx|css|tailwind|swarmview|drafts|frontend|web\/src)\b/i;
const DIRECTIVE_FILE_REF = /(?:^|[\s"'`(])([\w./-]+\.(?:tsx|jsx|ts|css))(?:\b|[\s"'`),])/gi;

/** D11: directive names a narrow UI/front-end change (not a repo-wide refactor). */
export function isScopedUiDirective(directive: string): boolean {
  const d = directive.trim();
  if (d.length < 40) return false;
  return SCOPED_UI_KEYWORD.test(d);
}

/** Infer expected UI files from prefetched excerpts + directive mentions. */
export function inferScopedUiExpectedFiles(seed: PlannerSeed, directive: string): string[] {
  const paths = new Set<string>();
  for (const f of seed.codeContextExcerpts ?? []) {
    if (
      /\.(tsx|jsx|css)$/i.test(f.path)
      || f.path.replace(/\\/g, "/").includes("web/src/")
    ) {
      paths.add(f.path.replace(/\\/g, "/"));
    }
  }
  for (const m of directive.matchAll(DIRECTIVE_FILE_REF)) {
    paths.add(m[1]!.replace(/\\/g, "/"));
  }
  for (const p of seed.repoFiles) {
    const norm = p.replace(/\\/g, "/");
    if (!norm.includes("web/src/")) continue;
    const base = norm.split("/").pop() ?? "";
    if (base && directive.toLowerCase().includes(base.toLowerCase().replace(/\.(tsx|jsx|ts)$/i, ""))) {
      paths.add(norm);
    }
  }
  return [...paths].slice(0, 4);
}

/** D11: synthetic contract for scoped UI directives — skips LLM contract derivation. */
export function buildScopedUiContract(directive: string, expectedFiles: string[]): ParsedContract {
  const trimmed = directive.trim();
  const mission =
    trimmed.length <= 500 ? trimmed : trimmed.slice(0, 497) + "...";
  const desc =
    trimmed.length <= 400 ? trimmed : trimmed.slice(0, 397) + "...";
  return {
    missionStatement: mission,
    criteria: [
      {
        description: desc,
        expectedFiles: expectedFiles.slice(0, 4),
      },
    ],
  };
}

/**
 * D11: skip expensive contract LLM when directive is scoped UI work and seed
 * already prefetched the target files.
 */
export function shouldSkipContractDerivation(
  cfg: RunConfig | undefined,
  seed: PlannerSeed,
): boolean {
  if (!cfg || cfg.preset !== "blackboard") return false;
  if (cfg.skipContractDerivation === true) return true;
  if (!resolvePlanningFastPath(cfg)) return false;
  const directive = (seed.userDirective ?? cfg.userDirective ?? "").trim();
  if (!isScopedUiDirective(directive)) return false;
  const files = inferScopedUiExpectedFiles(seed, directive);
  return files.length > 0 || (seed.codeContextExcerpts?.length ?? 0) > 0;
}

export function shouldRunGoalPrePass(cfg: RunConfig, directive?: string): boolean {
  if (resolvePlanningFastPath(cfg)) return false;
  if (cfg.autoGenerateGoals === false) return false;
  const d = (directive ?? cfg.userDirective ?? "").trim();
  if (d.length >= SUBSTANTIAL_DIRECTIVE_MIN_CHARS) {
    // Substantial directive: skip unless user explicitly opted in.
    return cfg.autoGenerateGoals === true;
  }
  return true;
}

export function resolvePlanningWallClockCapMs(cfg: RunConfig | undefined): number {
  const cap = cfg?.planningWallClockCapMs;
  if (typeof cap === "number" && cap > 0) return cap;
  return PLANNING_WALL_CLOCK_CAP_MS;
}

export function isPlanningWallClockExceeded(
  planningStartedAt: number | undefined,
  cfg: RunConfig | undefined,
  now = Date.now(),
): boolean {
  if (!planningStartedAt) return false;
  return now - planningStartedAt >= resolvePlanningWallClockCapMs(cfg);
}

/** Repo-only explore when endpoint catalog is already in the seed (no web_search). */
export function resolveContractExploreProfile(
  seed: PlannerSeed,
  cfg: RunConfig | undefined,
): ProfileName {
  if (seed.endpointCatalogBlock && seed.endpointCatalogBlock.trim().length > 0) {
    return "swarm-read";
  }
  return resolveToolProfile("planner", cfg);
}

export function shouldSkipPlannerAfterContractFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason.startsWith("think-guard-salvage:")) return false;
  if (reason.startsWith("transport:")) return true;
  if (reason === "run stopping") return true;
  return false;
}