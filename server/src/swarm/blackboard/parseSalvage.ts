// LLM JSON salvage for malformed agent output (planner, worker, contract).
// Reuses brain-parser prompt shapes; auditor agent performs extraction.

import type { Agent } from "../../services/AgentManager.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { stripForJsonParse } from "@ollama-swarm/shared/stripAgentText";
import { formatParseTier, parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";
import {
  formatUnparseableSalvageMessage,
  isUnparseableSalvageJson,
} from "@ollama-swarm/shared/unparseableSalvage";
import {
  SCHEMA_DESCRIPTIONS,
} from "./prompts/brainParser.js";

/** Emit-only: no tools — salvage decodes text already in the prompt. */
export const PARSE_SALVAGE_PROFILE = "swarm" as ProfileName;

export type SalvageKind =
  | "contract"
  | "planner-todos"
  | "worker"
  | "replanner"
  | "hunk-review"
  | "auditor";

const SALVAGE_SCHEMA_KEY: Record<SalvageKind, string> = {
  contract: "contract",
  "planner-todos": "planner",
  worker: "worker",
  replanner: "replanner",
  "hunk-review": "hunk-review",
  auditor: "auditor",
};

const MAX_SALVAGE_SNIPPET = 6000;

export function buildParseSalvagePrompt(args: {
  kind: SalvageKind;
  parseError: string;
  rawOutput: string;
}): string {
  const schemaKey = SALVAGE_SCHEMA_KEY[args.kind];
  const schemaDescription = SCHEMA_DESCRIPTIONS[schemaKey] ?? "valid JSON matching the expected schema";
  const snippet = stripForJsonParse(args.rawOutput);
  const clipped =
    snippet.length > MAX_SALVAGE_SNIPPET
      ? snippet.slice(0, MAX_SALVAGE_SNIPPET) + "\n... (truncated)"
      : snippet;

  return [
    `You are a JSON EXTRACTION assistant for a blackboard swarm ${args.kind} emit.`,
    "A prior agent produced output that failed structured parsing.",
    "Your job is to EXTRACT or RECONSTRUCT the intended JSON — not to explain the failure.",
    "",
    `Parser error: ${args.parseError}`,
    "",
    "Expected schema:",
    schemaDescription,
    "",
    "Raw output (thinking and pseudo-tool markers already stripped):",
    "---",
    clipped,
    "---",
    "",
    "Respond with ONLY valid JSON conforming to the schema.",
    "No prose. No markdown fences. No <think> tags. No XML tool calls.",
    'If fundamentally unparseable, respond with exactly: {"_unparseable":true}',
  ].join("\n");
}

export interface ParseSalvageResult {
  json: string;
  tier: string;
}

export async function runParseSalvage(
  salvageAgent: Agent,
  deps: {
    getStopping: () => boolean;
    appendSystem: (msg: string) => void;
    appendAgent: (
      agent: Agent,
      text: string,
      options?: { assistKind?: "auditor-salvage" },
    ) => void;
    promptPlannerSafely: (
      agent: Agent,
      promptText: string,
      agentName?: ProfileName,
      ollamaFormat?: "json" | Record<string, unknown>,
    ) => Promise<{ response: string; agentUsed: Agent }>;
    getActive: () => unknown;
    jsonSchema?: Record<string, unknown>;
  },
  input: {
    kind: SalvageKind;
    parseError: string;
    rawOutput: string;
    attempt: number;
  },
): Promise<ParseSalvageResult | null> {
  if (deps.getStopping()) return null;

  const prompt = buildParseSalvagePrompt({
    kind: input.kind,
    parseError: input.parseError,
    rawOutput: input.rawOutput,
  });

  deps.appendSystem(
    `[${salvageAgent.id}] auditor salvage: ${input.kind} parse failed (attempt ${input.attempt}) — extracting JSON.`,
  );

  const { response, agentUsed } = await deps.promptPlannerSafely(
    salvageAgent,
    prompt,
    PARSE_SALVAGE_PROFILE,
    deps.jsonSchema ?? "json",
  );
  if (deps.getStopping()) return null;

  const envelope = parseJsonEnvelope(response);
  if (!envelope.ok) {
    // Still surface a readable agent bubble (not raw garbage).
    deps.appendAgent(
      agentUsed,
      formatUnparseableSalvageMessage({
        kind: input.kind,
        parseError: envelope.reason,
      }),
      { assistKind: "auditor-salvage" },
    );
    deps.appendSystem(
      `[${salvageAgent.id}] auditor salvage failed to parse (${envelope.reason}).`,
    );
    return null;
  }

  if (
    isUnparseableSalvageJson(response)
    || (
      typeof envelope.value === "object"
      && envelope.value !== null
      && (envelope.value as { _unparseable?: unknown })._unparseable === true
    )
  ) {
    deps.appendAgent(
      agentUsed,
      formatUnparseableSalvageMessage({
        kind: input.kind,
        parseError: input.parseError,
      }),
      { assistKind: "auditor-salvage" },
    );
    deps.appendSystem(`[${salvageAgent.id}] auditor salvage: output marked unparseable.`);
    return null;
  }

  deps.appendAgent(agentUsed, response, { assistKind: "auditor-salvage" });
  deps.appendSystem(
    `[${salvageAgent.id}] auditor salvage succeeded (tier: ${formatParseTier(envelope.tier)}).`,
  );
  return { json: JSON.stringify(envelope.value), tier: formatParseTier(envelope.tier) };
}