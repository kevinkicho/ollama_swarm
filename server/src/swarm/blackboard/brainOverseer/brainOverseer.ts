// Brain overseer — ties together interaction tracking, exception collection,
// pattern analysis, and improvement proposals.
//
// Runs post-audit to analyze the run's interaction chains and exception
// patterns, then generates improvement proposals for the swarm system.

import { readPatternCache, writePatternCache, updateCache, type PatternCacheData } from "./patternCache.js";
import { readPatchCache, writePatchCache, computeContentHash, type PatchCacheData } from "./patchCache.js";
import type { InteractionTracker, InteractionChain } from "./interactionTracker.js";
import type { ExceptionCollector, PatternSummary } from "./exceptionCollector.js";
import { buildAnalysisPrompt } from "./prompt.js";

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
 * @param priorImprovements - list of prior improvement descriptions
 * @param promptFn - optional LLM prompt function for real analysis
 * @param model - optional model name for LLM calls
 * @returns Analysis result with chains, patterns, and proposals
 */
export async function runBrainAnalysis(
  interactionTracker: InteractionTracker,
  exceptionCollector: ExceptionCollector,
  clonePath: string,
  runId: string,
  priorImprovements: string[] = [],
  promptFn?: (prompt: string, model: string, maxTokens: number, timeoutMs: number) => Promise<string>,
  model?: string,
): Promise<BrainAnalysisResult> {
  const chains = interactionTracker.getChains();
  const exceptions = exceptionCollector.getPatternSummary();

  // Update pattern cache
  const priorCache = await readPatternCache(clonePath);
  const updatedCache = updateCache(priorCache, exceptionCollector.getAll(), runId);
  await writePatternCache(clonePath, updatedCache);

  // Try LLM analysis first, fall back to rule-based
  let proposals: ImprovementProposal[];
  if (promptFn && model) {
    try {
      proposals = await analyzeWithLLM(chains, exceptions, priorImprovements, promptFn, model);
    } catch (err) {
      console.warn(`[brain-overseer] LLM analysis failed, falling back to rules: ${err instanceof Error ? err.message : err}`);
      proposals = generateProposals(exceptions, updatedCache);
    }
  } else {
    proposals = generateProposals(exceptions, updatedCache);
  }

  return {
    chains,
    exceptions,
    proposals,
  };
}

/**
 * Analyze patterns using an LLM for deeper insights.
 */
async function analyzeWithLLM(
  chains: InteractionChain[],
  exceptions: PatternSummary,
  priorImprovements: string[],
  promptFn: (prompt: string, model: string, maxTokens: number, timeoutMs: number) => Promise<string>,
  model: string,
): Promise<ImprovementProposal[]> {
  const prompt = buildAnalysisPrompt(chains, exceptions, priorImprovements);
  const response = await promptFn(prompt, model, 4096, 60_000);

  // Parse JSON array from response
  try {
    // Try to extract JSON array from the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in response");
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      throw new Error("Response is not an array");
    }

    // Validate and normalize each proposal
    return parsed
      .filter((p: unknown) => {
        const obj = p as Record<string, unknown>;
        return obj && typeof obj.title === "string" && typeof obj.description === "string";
      })
      .map((p: unknown) => {
        const obj = p as Record<string, unknown>;
        return {
          title: String(obj.title),
          description: String(obj.description),
          affectedComponent: String(obj.affectedComponent || "unknown"),
          priority: ["high", "medium", "low"].includes(String(obj.priority))
            ? (String(obj.priority) as "high" | "medium" | "low")
            : "medium",
        };
      });
  } catch (err) {
    throw new Error(`Failed to parse LLM response: ${err instanceof Error ? err.message : err}`);
  }
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
