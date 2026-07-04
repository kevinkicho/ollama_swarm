/**
 * Server-side preset guide (re-exports data from shared + adds build helpers).
 * 
 * Data now lives in shared/src/presetGuide.ts so UI, agents, and backend can share.
 */

import {
  PRESETS_GUIDE as SHARED_PRESETS_GUIDE,
  USE_CASE_FILTERS,
  type PresetInfo,
} from "../../../shared/src/presetGuide.js";

export { USE_CASE_FILTERS, type PresetInfo };
export const PRESETS_GUIDE = SHARED_PRESETS_GUIDE;

export const RESEARCH_USE_CASE_GUIDANCE = `
RESEARCH / USE-CASE GUIDANCE:
- User wants to "think deeply + produce reports/findings/code" → Hybrid council→blackboard + webTools + plannerTools.
- Pure analysis / "what do these have in common" / hypothesis → council (standalone) or moa.
- Broad scan of many sources/papers → map-reduce.
- Need external knowledge (papers, gov data, recent info) → always suggest webTools: true + plannerTools: true.
- No file changes, just understanding → discussion presets (council, map-reduce, moa, role-diff, pipeline, stigmergy).
- Needs safe writes + audit trail → blackboard (or hybrid).
- User describes "debate", "pros cons", "should we" → debate-judge or council.
- Open discovery without clear goal → stigmergy.
`;

export function buildPresetGuideString(): string {
  const lines: string[] = [
    "SWARM PRESET QUICK REFERENCE (use this to recommend precisely):",
    "",
  ];

  for (const [id, info] of Object.entries(PRESETS_GUIDE)) {
    lines.push(`- ${id} (${info.label}): ${info.strengths}`);
  }

  lines.push("");
  lines.push(RESEARCH_USE_CASE_GUIDANCE.trim());
  lines.push("");
  lines.push(
    "When user is unsure what 'swarm mode' / preset to use, analyze their described goal:\n" +
      "1. Does it require writing/editing files with safety? → blackboard or hybrid.\n" +
      "2. Is it research/literature/analysis/synthesis? → council, map-reduce, moa, role-diff, hybrid.\n" +
      "3. Exploration / 'tell me about'? → stigmergy or map-reduce.\n" +
      "4. Decision / debate? → debate-judge / council.\n" +
      "Always explain your choice with 2-3 concrete reasons referencing the user's words and the preset strengths above."
  );

  return lines.join("\n");
}

/**
 * Returns a compact markdown table of preset options for a given goal.
 * Useful for "explain all the options" responses.
 */
export function buildOptionsTable(goal: string): string {
  const rows = Object.values(PRESETS_GUIDE)
    .map((p) => `| ${p.label} | ${p.strengths.slice(0, 80)}... | ${p.bestFor.join(", ")} |`)
    .join("\n");

  return `| Preset | Strengths (summary) | Good for |\n|--------|---------------------|----------|\n${rows}\n\nBased on your goal: "${goal}". The strongest matches are usually those whose bestFor tags overlap with the described intent.`;
}
