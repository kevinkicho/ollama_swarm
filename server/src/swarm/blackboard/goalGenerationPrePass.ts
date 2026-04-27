// Task #164 (refactor): goal-generation pre-pass (#127) extracted
// from BlackboardRunner.ts.
//
// Asks the planner agent to propose 3-5 ambitious-but-feasible
// improvements to the repo, then picks the top one (highest
// impact:effort, surfaced as `TOP: N` on a trailing line) as the
// directive. Returns the chosen directive string, or undefined when
// the model's response can't be salvaged — caller silently falls
// back to planner-from-scratch.
//
// Costs one planner prompt; cheap. Failure-open everywhere.

import type { Agent } from "../../services/AgentManager.js";
import { extractText } from "../extractText.js";
import { parseGoalList } from "./goalListParser.js";
import type { PlannerSeed } from "./prompts/planner.js";

export async function runGoalGenerationPrePass(
  planner: Agent,
  seed: PlannerSeed,
  appendSystem: (text: string) => void,
  // Issue C-min (2026-04-27): caller-provided callbacks so the UI
  // shows agent.status="thinking" while this pass is in flight (was
  // showing "ready" because this code path bypasses promptAgent),
  // and so the runner can abort the prompt via signal if needed.
  opts: {
    signal?: AbortSignal;
    onStatusChange?: (status: "thinking" | "ready") => void;
  } = {},
): Promise<string | undefined> {
  appendSystem("Goal-generation pre-pass: asking planner to propose ambitious goals…");
  const topLevelText = seed.topLevel.slice(0, 60).join(", ");
  const readmeText = seed.readmeExcerpt
    ? `=== README excerpt ===\n${seed.readmeExcerpt.slice(0, 4000)}\n=== END ===`
    : "(no README)";
  const prompt = [
    "You are a senior engineer doing a one-shot triage of an unfamiliar repo.",
    `Repo: ${seed.repoUrl}`,
    `Top-level entries: ${topLevelText}`,
    "",
    readmeText,
    "",
    "Propose 3-5 AMBITIOUS-BUT-FEASIBLE improvements ranked by impact:effort. Each:",
    "- 1 sentence describing the improvement.",
    "- Cites 1-3 file paths from the repo where the work would land.",
    "- Notes WHY it's ambitious (what gets unlocked) and WHY feasible (concrete attack path, no research wave required).",
    "",
    "Avoid trivia (typo fixes, dependency bumps, doc-only edits). Favor structural improvements that would matter to the next person reading the code.",
    "",
    "Output format:",
    "1. [TITLE] - one-sentence description (files: a/b.ts, c.ts) — Ambitious because X. Feasible because Y.",
    "2. ...",
    "",
    "After the list, on a NEW LINE, write `TOP: <number>` (e.g. `TOP: 1`) — the single goal that has the best impact:effort ratio. The user will run a swarm against this top goal.",
  ].join("\n");

  if (opts.signal?.aborted) return undefined;
  opts.onStatusChange?.("thinking");
  try {
    const res = await planner.client.session.prompt({
      path: { id: planner.sessionId },
      body: {
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: prompt }],
      },
      signal: opts.signal,
    });
    const text = extractText(res);
    if (!text) return undefined;
    const topMatch = /^\s*TOP\s*:\s*(\d+)\s*$/im.exec(text);
    const items = parseGoalList(text);
    if (items.length === 0) return undefined;
    const topIdx = topMatch ? Math.max(1, Math.min(items.length, Number(topMatch[1]!))) - 1 : 0;
    return items[topIdx];
  } catch (err) {
    appendSystem(
      `Goal-generation pre-pass failed (${err instanceof Error ? err.message : String(err)}); falling back to planner-from-scratch.`,
    );
    return undefined;
  } finally {
    opts.onStatusChange?.("ready");
  }
}
