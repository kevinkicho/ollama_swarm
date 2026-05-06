// #88 (2026-05-01) — extracted from MoaRunner.runAggregationTree +
// runAggregatorSelfCritique. Pure functions + context-object pattern.
// The calling runner passes all dependencies as parameters; no `this`.

import type { Agent } from "../services/AgentManager.js";
import type { AgentManager } from "../services/AgentManager.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractText } from "./extractText.js";
import { describeSdkError } from "./sdkError.js";
import { buildAggregatorPrompt, chunkRoundRobin } from "./moaPromptHelpers.js";

// ---------------------------------------------------------------------------
// runAggregationTree
// ---------------------------------------------------------------------------

export interface AggregationTreeInput {
  seed: string;
  initialInputs: ReadonlyArray<{ workerId: string; text: string }>;
  levels: number;
  availableAggregators: readonly Agent[];
  manager: AgentManager;
  appendSystem: (text: string) => void;
}

export interface AggregationTreeResult {
  text: string;
  layerSizes: number[];
}

export async function runAggregationTree(
  input: AggregationTreeInput,
): Promise<AggregationTreeResult> {
  const { seed, initialInputs, levels, availableAggregators, manager, appendSystem } = input;
  if (availableAggregators.length === 0) {
    throw new Error("runAggregationTree: no aggregators available");
  }
  let currentLayer: Array<{ workerId: string; text: string }> = [
    ...initialInputs,
  ];
  const layerSizes: number[] = [currentLayer.length];
  for (let level = 1; level <= levels; level++) {
    const isTopLevel = level === levels;
    const nextSize = isTopLevel ? 1 : Math.max(1, Math.ceil(currentLayer.length / 2));
    const chunks = chunkRoundRobin(currentLayer, nextSize);
    const tasks = chunks.map(async (chunk, idx) => {
      if (chunk.length === 0) return null;
      if (chunk.length === 1) return chunk[0]!;
      const agg = availableAggregators[idx % availableAggregators.length]!;
      const prompt = buildAggregatorPrompt({
        seed,
        proposals: chunk,
        variantBias: "balanced",
      });
      try {
        const ctrl = new AbortController();
        const result = (await promptWithFailoverAuto(agg, prompt, {
          signal: ctrl.signal,
          manager,
          agentName: "swarm-read",
          describeError: (e) => describeSdkError(e),
        })) as { data?: { parts?: Array<{ type: string; text: string }> } };
        const text = extractText(
          result.data?.parts?.find((p) => p.type === "text")?.text ?? "",
        );
        if (!text || text.trim().length === 0) return null;
        return { workerId: `L${level}-agg-${idx + 1}`, text };
      } catch {
        return null;
      }
    });
    const settled = await Promise.all(tasks);
    const valid = settled.filter(
      (s): s is { workerId: string; text: string } => s !== null,
    );
    if (valid.length === 0) {
      return {
        text: currentLayer[0]?.text ?? "",
        layerSizes,
      };
    }
    currentLayer = valid;
    layerSizes.push(currentLayer.length);
    if (isTopLevel) break;
  }
  return { text: currentLayer[0]!.text, layerSizes };
}

// ---------------------------------------------------------------------------
// runAggregatorSelfCritique
// ---------------------------------------------------------------------------

export interface SelfCritiqueInput {
  agg: Agent;
  synthesis: string;
  proposals: ReadonlyArray<{ workerId: string; text: string }>;
  runOne: (agent: Agent, prompt: string, label: string) => Promise<string>;
  appendSystem: (text: string) => void;
  stopping: boolean;
}

export async function runAggregatorSelfCritique(
  input: SelfCritiqueInput,
): Promise<string> {
  const { agg, synthesis, proposals, runOne, appendSystem, stopping } = input;
  if (proposals.length < 2) return synthesis;
  if (stopping) return synthesis;
  const prompt = [
    "You are reviewing YOUR OWN synthesis for the MoA team. Read the proposers' answers below and your synthesis, then decide:",
    "  - APPROVED: synthesis fairly captures consensus AND surfaces meaningful disagreement.",
    "  - REVISE: synthesis dropped substantive disagreement, over-weighted one proposer, or smoothed away a real tradeoff.",
    "",
    "Output STRICT JSON only, no prose, no markdown fences:",
    '  {"verdict": "APPROVED" | "REVISE", "rationale": "<one sentence>", "revised": "<full revised synthesis if REVISE, else empty string>"}',
    "",
    "Be honest. APPROVED is fine when the synthesis is good. Only REVISE when there's a SPECIFIC named gap (e.g. 'Proposer 3 raised X which I dropped').",
    "",
    `PROPOSERS (${proposals.length}):`,
    ...proposals.map(
      (p, i) => `\n--- Proposer ${i + 1} (${p.workerId}) ---\n${p.text.slice(0, 2000)}`,
    ),
    "",
    "YOUR CURRENT SYNTHESIS:",
    "--- BEGIN ---",
    synthesis.slice(0, 4000),
    "--- END ---",
    "",
    "Output JSON now:",
  ].join("\n");
  let raw: string;
  try {
    raw = await runOne(agg, prompt, "aggregator-self-critique");
  } catch {
    return synthesis;
  }
  if (!raw) return synthesis;
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return synthesis;
  let parsed: { verdict?: unknown; rationale?: unknown; revised?: unknown };
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return synthesis;
  }
  const verdict = parsed.verdict === "REVISE" ? "REVISE" : "APPROVED";
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (verdict === "APPROVED") {
    appendSystem(`[matrix #3] Aggregator self-critique: APPROVED. ${rationale}`);
    return synthesis;
  }
  const revised = typeof parsed.revised === "string" ? parsed.revised.trim() : "";
  if (revised.length < 50) {
    appendSystem(
      `[matrix #3] Aggregator self-critique flagged REVISE but produced no usable revision; keeping original synthesis. (${rationale})`,
    );
    return synthesis;
  }
  appendSystem(`[matrix #3] Aggregator self-critique: REVISED. ${rationale}`);
  return revised;
}