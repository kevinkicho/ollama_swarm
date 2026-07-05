// Brain overseer — ties together interaction tracking, exception collection,
// pattern analysis, and improvement proposals.
//
// Runs post-audit to analyze the run's interaction chains and exception
// patterns, then generates improvement proposals for the swarm system.

import { readPatternCache, writePatternCache, updateCache, type PatternCacheData } from "./patternCache.js";
import { readProposals, appendProposal, type PersistedProposal } from "./proposalStore.js";
import { readAllRunSummaries, analyzeSummaries, type RunSummary } from "./dataPipeline.js";
import type { InteractionTracker, InteractionChain } from "./interactionTracker.js";
import type { ExceptionCollector, PatternSummary } from "./exceptionCollector.js";
import { buildAnalysisPrompt } from "./prompt.js";
import path from "node:path";
import { createSelfUpgrader } from "./selfUpgrader.js";

// NOTE: Brain no longer generates system patches or scans its own source.
// It acts as librarian/master-admin focused on run records and analysis.

export interface BrainAnalysisResult {
  chains: InteractionChain[];
  exceptions: PatternSummary;
  insights: RunInsight[];           // Renamed from "proposals" — final run analysis insights
  runSummaries: RunSummary[];
  summaryAnalysis: ReturnType<typeof analyzeSummaries>;
}

export interface RunInsight {
  title: string;
  description: string;
  category?: "summary" | "lesson" | "recommendation" | "followup" | "research";
  priority: "high" | "medium" | "low";
  id?: string;
  // No more suggestedHunks for patching the swarm platform.
}

export interface ImprovementProposal extends RunInsight {} // legacy alias for minimal breakage in some places

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
  let insights: RunInsight[];
  if (promptFn && model) {
    try {
      insights = await analyzeWithLLM(chains, exceptions, priorImprovements, promptFn, model);
    } catch (err) {
      console.warn(`[brain-overseer] LLM analysis failed, falling back to rules: ${err instanceof Error ? err.message : err}`);
      insights = generateInsights(exceptions, updatedCache);
    }
  } else {
    insights = generateInsights(exceptions, updatedCache);
  }

  // Persist insights (as before, using the proposals store for run knowledge)
  for (const insight of insights) {
    await appendProposal(clonePath, insight);
  }

  // Read historical run summaries for context (librarian role)
  const logsDir = path.join(clonePath, "logs");
  const runSummaries = await readAllRunSummaries(logsDir);
  const summaryAnalysis = analyzeSummaries(runSummaries);

  // Work on upgrade: record any "system" insights via self-upgrader (safe mode)
  // so the brain can track self-improvement proposals.
  try {
    const upgrader = createSelfUpgrader({ clonePath, enabled: true });
    for (const ins of insights) {
      if (ins.category === "recommendation" || ins.title.toLowerCase().includes("system") || ins.title.toLowerCase().includes("prompt")) {
        await upgrader.applyPatch({ title: ins.title, description: ins.description });
      }
    }
  } catch (e) {
    // non-fatal
  }

  return {
    chains,
    exceptions,
    insights,
    runSummaries,
    summaryAnalysis,
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
): Promise<RunInsight[]> {
  const prompt = buildAnalysisPrompt(chains, exceptions, priorImprovements);
  const response = await promptFn(prompt, model, 4096, 60_000);

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in response");
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      throw new Error("Response is not an array");
    }

    return parsed
      .filter((p: unknown) => {
        const obj = p as Record<string, unknown>;
        return obj && typeof obj.title === "string" && typeof obj.description === "string";
      })
      .map((p: unknown) => {
        const obj = p as Record<string, unknown>;
        const category = ["summary", "lesson", "recommendation", "followup", "research"].includes(String(obj.category))
          ? (String(obj.category) as any)
          : undefined;
        return {
          title: String(obj.title),
          description: String(obj.description),
          category,
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
 * Generate run insights from patterns (rule-based fallback).
 * Focus: lessons and recommendations about the *task run*, never platform code edits.
 */
function generateInsights(
  exceptions: PatternSummary,
  cache: PatternCacheData,
): RunInsight[] {
  const insights: RunInsight[] = [];

  for (const pattern of exceptions.recurringPatterns) {
    const cached = cache.patterns[pattern.pattern];
    if (cached && cached.confidence >= 0.8 && cached.proposal) {
      insights.push({
        title: cached.proposal.title,
        description: cached.proposal.description,
        category: "lesson",
        priority: cached.proposal.priority || "medium",
      });
      continue;
    }

    const insight = generateInsightFromPattern(pattern);
    if (insight) insights.push(insight);
  }

  if (exceptions.totalExceptions > 0 && insights.length === 0) {
    insights.push({
      title: "Run had recurring execution issues",
      description: `${exceptions.totalExceptions} exceptions. Patterns may indicate task complexity or directive clarity issues.`,
      category: "lesson",
      priority: "medium",
    });
  }

  // Research-oriented template (leveraged for scientific / web-heavy runs)
  if (insights.length === 0) {
    insights.push({
      title: "Research follow-up opportunity",
      description: "Consider a follow-up run with webTools + hybrid council planning to deepen analysis or synthesize literature findings.",
      category: "research",
      priority: "low",
    });
  }

  return insights;
}

function generateInsightFromPattern(pattern: { pattern: string; count: number; suggestedFix: string }): RunInsight | null {
  const [type, reasonKey] = pattern.pattern.split("|");

  if (type === "worker_declined") {
    return {
      title: `Frequent worker declines (${pattern.count}x)`,
      description: pattern.suggestedFix || `Common pattern "${reasonKey}". Consider more explicit file anchors or smaller todos for this type of task.`,
      category: "lesson",
      priority: pattern.count > 4 ? "high" : "medium",
    };
  }

  if (type === "replanner_skip") {
    return {
      title: `Replanner frequently skipped (${pattern.count}x)`,
      description: pattern.suggestedFix || "Consider lower ambition or more granular planning for complex repos.",
      category: "recommendation",
      priority: "medium",
    };
  }

  if (pattern.suggestedFix) {
    return {
      title: `Observed pattern: ${type}`,
      description: pattern.suggestedFix,
      category: "lesson",
      priority: "low",
    };
  }
  return null;
}
