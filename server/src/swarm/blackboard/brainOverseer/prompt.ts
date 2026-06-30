// Brain overseer prompt for system-level analysis.
//
// This prompt is used by the brain to analyze interaction chains and
// exception patterns, then propose concrete improvements to the swarm system.

import type { PatternSummary } from "./exceptionCollector.js";
import type { InteractionChain } from "./interactionTracker.js";

export function buildAnalysisPrompt(
  chains: InteractionChain[],
  exceptions: PatternSummary,
  priorImprovements: string[],
): string {
  const chainText = chains
    .slice(0, 20) // Limit to most recent 20 chains
    .map((chain) => {
      const events = chain.events.map((e) => `  - ${e.type}: ${e.reason}`).join("\n");
      return `Chain for todo ${chain.todoId}:\n${events}`;
    })
    .join("\n\n");

  const patternText = exceptions.recurringPatterns
    .map((p) => `- ${p.pattern} (${p.count}x): ${p.suggestedFix || "no fix suggested yet"}`)
    .join("\n");

  const typeBreakdown = Object.entries(exceptions.byType)
    .map(([type, count]) => `  ${type}: ${count}`)
    .join("\n");

  const priorText = priorImprovements.length > 0
    ? priorImprovements.map((p) => `- ${p}`).join("\n")
    : "(no prior improvements)";

  return [
    "You are the SYSTEM OVERSEER for a coding-agent swarm. Your job is to analyze",
    "failure patterns and propose improvements to the system itself — not to the",
    "project code.",
    "",
    "=== INTERACTION CHAINS (this run) ===",
    chainText || "(no interaction chains recorded)",
    "",
    "=== EXCEPTION PATTERNS ===",
    `Total exceptions: ${exceptions.totalExceptions}`,
    "By type:",
    typeBreakdown,
    "",
    "Recurring patterns:",
    patternText || "(no recurring patterns)",
    "",
    "=== PRIOR IMPROVEMENTS ===",
    priorText,
    "",
    "=== YOUR TASK ===",
    "Analyze these interaction chains and exception patterns. Produce:",
    "1. Root causes for recurring skip/decline chains",
    "2. Which patterns are most impactful to fix",
    "3. Concrete improvement proposals with priority ranking",
    "4. For each proposal: title, description, affected component, priority",
    "",
    "Focus on changes that would prevent the patterns from recurring.",
    "Do NOT propose changes to the project code — only to the swarm system.",
    "",
    "Output: JSON array of proposals.",
    'Format: [{"title": "...", "description": "...", "affectedComponent": "...", "priority": "high|medium|low"}]',
  ].join("\n");
}
