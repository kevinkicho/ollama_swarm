// Brain overseer — ties together interaction tracking, exception collection,
// pattern analysis, and improvement proposals.
//
// Runs post-audit to analyze the run's interaction chains and exception
// patterns, then generates improvement proposals for the swarm system.

import { readPatternCache, writePatternCache, updateCache, type PatternCacheData } from "./patternCache.js";
import { readPatchCache, writePatchCache, computeContentHash, type PatchCacheData } from "./patchCache.js";
import type { InteractionTracker, InteractionChain } from "./interactionTracker.js";
import type { ExceptionCollector, PatternSummary } from "./exceptionCollector.js";

export interface BrainAnalysisResult {
  chains: InteractionChain[];
  exceptions: PatternSummary;
  proposals: ImprovementProposal[];
}

export interface ImprovementProposal {
  title: string;
  description: string;
  affectedComponent: string;
  priority: "high" | "medium" | "low";
}

/**
 * Run the brain overseer analysis for a completed run.
 *
 * @param interactionTracker - tracker with interaction chains from this run
 * @param exceptionCollector - collector with exception events from this run
 * @param clonePath - path to the project root (for reading/writing caches)
 * @param runId - current run ID
 * @returns Analysis result with chains, patterns, and proposals
 */
export async function runBrainAnalysis(
  interactionTracker: InteractionTracker,
  exceptionCollector: ExceptionCollector,
  clonePath: string,
  runId: string,
): Promise<BrainAnalysisResult> {
  const chains = interactionTracker.getChains();
  const exceptions = exceptionCollector.getPatternSummary();

  // Update pattern cache
  const priorCache = await readPatternCache(clonePath);
  const updatedCache = updateCache(priorCache, exceptionCollector.getAll(), runId);
  await writePatternCache(clonePath, updatedCache);

  // Generate proposals based on patterns
  const proposals = generateProposals(exceptions, updatedCache);

  return {
    chains,
    exceptions,
    proposals,
  };
}

/**
 * Generate improvement proposals from exception patterns.
 * Uses cached patterns to avoid re-analyzing known issues.
 */
function generateProposals(
  exceptions: PatternSummary,
  cache: PatternCacheData,
): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  for (const pattern of exceptions.recurringPatterns) {
    const cached = cache.patterns[pattern.pattern];

    // Skip if already analyzed with high confidence
    if (cached && cached.confidence >= 0.8 && cached.proposal) {
      proposals.push(cached.proposal);
      continue;
    }

    // Generate proposal based on pattern type
    const proposal = generateProposalFromPattern(pattern);
    if (proposal) {
      proposals.push(proposal);
      // Update cache with the new proposal
      if (cached) {
        cached.proposal = proposal;
        cached.confidence = 0.7; // Initial confidence
        cached.rootCause = proposal.description;
      }
    }
  }

  return proposals;
}

/**
 * Generate a single proposal from a pattern.
 */
function generateProposalFromPattern(pattern: { pattern: string; count: number; suggestedFix: string }): ImprovementProposal | null {
  const [type, reasonKey] = pattern.pattern.split("|");

  if (type === "worker_declined") {
    if (reasonKey.includes("not visible") || reasonKey.includes("omitted middle")) {
      return {
        title: "Auto-anchor for worker file visibility",
        description: "Workers decline when target sections are in the omitted middle of large files. Add auto-anchor detection from todo description to show relevant regions.",
        affectedComponent: "workerRunner.ts + autoAnchor.ts",
        priority: "high",
      };
    }
    if (reasonKey.includes("already exists")) {
      return {
        title: "Pre-check existing files before posting TODOs",
        description: "Workers decline because the file already exists. The planner should check for existing files before posting TODOs.",
        affectedComponent: "planner.ts",
        priority: "medium",
      };
    }
  }

  if (type === "replanner_skip") {
    if (reasonKey.includes("reorganized") || reasonKey.includes("moved")) {
      return {
        title: "Auto-anchor for replanner on file reorganization",
        description: "Replanner skips when sections are renamed/moved. Add auto-anchor detection and strengthen skip prompt to prefer revising over skipping.",
        affectedComponent: "replanManager.ts + replanner.ts",
        priority: "high",
      };
    }
  }

  if (type === "empty_response") {
    return {
      title: "Improve empty response handling",
      description: "Model produces empty output during thinking. Consider increasing timeout or adding retry with different prompt.",
      affectedComponent: "promptRunner.ts",
      priority: "medium",
    };
  }

  return null;
}
