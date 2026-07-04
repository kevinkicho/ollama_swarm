// Brain librarian / master-admin prompt.
//
// The Brain acts as the central librarian and administrator for swarm runs.
// It reviews run records, provides final analysis, helps with initialization,
// starting/finishing runs, and extracting cross-run knowledge.
// It does NOT modify or propose patches to the swarm system's own code.

import type { PatternSummary } from "./exceptionCollector.js";
import type { InteractionChain } from "./interactionTracker.js";

export function buildAnalysisPrompt(
  chains: InteractionChain[],
  exceptions: PatternSummary,
  priorImprovements: string[],
): string {
  const chainText = chains
    .slice(0, 20)
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
    : "(no prior run analyses)";

  return [
    "You are the BRAIN LIBRARIAN / MASTER-ADMIN for ollama_swarm.",
    "Your role is to manage run lifecycle knowledge:",
    "- Review completed run records (transcripts, todos, exceptions, outcomes).",
    "- Provide clear FINAL RUN ANALYSIS: what was achieved, key findings, metrics, lessons.",
    "- Help initialize context and suggest good run parameters based on history.",
    "- Assist starting and finishing runs by recording insights.",
    "- Review historical run records and surface cross-run patterns for the user.",
    "",
    "You NEVER propose changes to the swarm platform code itself.",
    "All analysis is about the target task and the specific run's results.",
    "",
    "=== THIS RUN'S INTERACTION CHAINS ===",
    chainText || "(no interaction chains recorded)",
    "",
    "=== EXCEPTION PATTERNS IN THIS RUN ===",
    `Total exceptions: ${exceptions.totalExceptions}`,
    "By type:",
    typeBreakdown,
    "",
    "Recurring patterns:",
    patternText || "(no recurring patterns)",
    "",
    "=== PRIOR RUN ANALYSES ===",
    priorText,
    "",
    "=== YOUR TASK ===",
    "Produce a final run analysis as an array of insights/recommendations:",
    "1. High-level summary of what the run accomplished.",
    "2. Key successes and failures with evidence from the transcript/todos.",
    "3. Actionable lessons or patterns for future similar tasks.",
    "4. Suggestions for follow-up runs (different preset, more agents, better directive, etc.).",
    "",
    "For each item output: title, description, category (summary|lesson|recommendation|followup), priority (high|medium|low).",
    "",
    "Output ONLY valid JSON:",
    '[{"title": "...", "description": "...", "category": "summary|lesson|recommendation|followup", "priority": "high|medium|low"}]',
  ].join("\n");
}
