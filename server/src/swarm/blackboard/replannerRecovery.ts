// Replanner structured emit recovery — mirrors plannerRecovery for single JSON objects.

import type { Agent } from "../../services/AgentManager.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import {
  extractJsonCandidate,
  formatParseTier,
} from "@ollama-swarm/shared/parseAgentJson";
import { interruptibleSleep } from "../interruptibleSleep.js";
import { runParseSalvage } from "./parseSalvage.js";
import { isRetryableSdkError } from "./retry.js";
import { describeSdkError } from "../sdkError.js";
import { isThinkGuardAbort } from "@ollama-swarm/shared/thinkGuardErrors";
import type { ReplanPolicy } from "@ollama-swarm/shared/replanPolicy";
import {
  REPLANNER_JSON_SCHEMA,
} from "./prompts/jsonSchemas.js";

export const REPLANNER_EMIT_MAX_ATTEMPTS = 4;
export const REPLANNER_EMIT_PAUSE_BASE_MS = 10_000;

export type ReplannerParseAttempt<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; reason: string; raw: string };

export interface ReplannerEmitRecoveryOpts<T> {
  agent: Agent;
  auditor?: Agent;
  policy: ReplanPolicy;
  getStopping: () => boolean;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  emitActivity: (label: string, attempt: number, maxAttempts: number, mode: "explore" | "emit") => void;
  promptPlannerSafely: (
    agent: Agent,
    promptText: string,
    agentName: ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: {
      kind?: string;
      label?: string;
      maxToolTurns?: number;
      mode?: "explore" | "emit";
    },
  ) => Promise<{ response: string; agentUsed: Agent }>;
  buildPrimaryPrompt: () => string;
  buildRepairPrompt: (previousResponse: string, parseError: string) => string;
  exploreProfile: ProfileName;
  emitProfile: ProfileName;
  parse: (raw: string) => ReplannerParseAttempt<T>;
  getActive: () => { dedicatedAuditor?: boolean } | undefined;
  maxAttempts?: number;
  onExploreCaptured?: (raw: string) => void;
}

function tryParseWithRuleBasedExtract<T>(
  raw: string,
  parse: (r: string) => ReplannerParseAttempt<T>,
  appendSystem: (msg: string) => void,
  agentId: string,
): ReplannerParseAttempt<T> {
  const direct = parse(raw);
  if (direct.ok) return direct;
  const candidate = extractJsonCandidate(raw);
  if (!candidate) return direct;
  const salvaged = parse(candidate.json);
  if (salvaged.ok) {
    appendSystem(
      `[${agentId}] replan rule-based JSON extract (${formatParseTier(candidate.tier)}) succeeded.`,
    );
    return salvaged;
  }
  return direct;
}

export async function runReplannerEmitRecovery<T>(
  opts: ReplannerEmitRecoveryOpts<T>,
): Promise<{ ok: true; value: T; raw: string } | { ok: false; reason: string; lastRaw: string }> {
  const maxAttempts = opts.maxAttempts ?? REPLANNER_EMIT_MAX_ATTEMPTS;
  let lastRaw = "";
  let lastReason = "no attempts";
  let exploreResponse = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.getStopping()) {
      return { ok: false, reason: "run stopping", lastRaw };
    }
    if (attempt > 1) {
      const ms = REPLANNER_EMIT_PAUSE_BASE_MS * Math.min(attempt - 1, 4);
      const controller = new AbortController();
      await interruptibleSleep(ms, controller.signal);
    }

    const policyEmitFirst = opts.policy.emitFirst && attempt === 1;
    const useEmitOnly = policyEmitFirst
      || (opts.policy.emitFirst && attempt % 2 === 1)
      || (attempt >= 2 && attempt % 2 === 0 && exploreResponse.length > 0);
    const allowExploreThisAttempt =
      !useEmitOnly && opts.policy.allowExplore && (attempt === 1 || exploreResponse.length === 0);
    const mode: "explore" | "emit" = allowExploreThisAttempt ? "explore" : "emit";
    const profile = mode === "explore" ? opts.exploreProfile : opts.emitProfile;
    const maxToolTurns =
      mode === "emit"
        ? 0
        : opts.policy.maxToolTurns;

    const label = mode === "explore" ? "replan explore" : "replan emit";
    opts.emitActivity(label, attempt, maxAttempts, mode);
    opts.appendSystem(
      `[${opts.agent.id}] ${label} — attempt ${attempt}/${maxAttempts}${mode === "emit" ? " (structured emit)" : ""}`,
    );

    const prompt =
      attempt === 1 && mode === "explore"
        ? opts.buildPrimaryPrompt()
        : mode === "emit" && attempt === 1 && policyEmitFirst
          ? opts.buildPrimaryPrompt()
          : opts.buildRepairPrompt(lastRaw || exploreResponse, lastReason);

    let response: string;
    let agentUsed: Agent;
    try {
      const prompted = await opts.promptPlannerSafely(
        opts.agent,
        prompt,
        profile,
        mode === "emit" ? REPLANNER_JSON_SCHEMA : undefined,
        {
          kind: "replan",
          label,
          mode,
          maxToolTurns: mode === "emit" ? 0 : maxToolTurns,
        },
      );
      response = prompted.response;
      agentUsed = prompted.agentUsed;
    } catch (err) {
      if (opts.getStopping()) return { ok: false, reason: "run stopping", lastRaw };
      if (isThinkGuardAbort(err)) {
        lastRaw = err.partialText;
        const brief = err.verdict?.salvageableBrief?.trim();
        if (
          brief
          || err.verdict?.suggestedAction === "force_emit"
          || err.verdict?.suggestedAction === "nudge_emit"
          || err.verdict?.verdict === "ready_to_emit"
        ) {
          lastReason = `think-guard-salvage: ${err.reason}`;
          exploreResponse = brief || err.partialText;
          continue;
        }
        lastReason = `think-guard: ${err.reason}`;
        return { ok: false, reason: lastReason, lastRaw };
      }
      const msg = describeSdkError(err);
      lastReason = `transport: ${msg}`;
      if (!isRetryableSdkError(err)) {
        return { ok: false, reason: lastReason, lastRaw };
      }
      continue;
    }
    if (opts.getStopping()) return { ok: false, reason: "run stopping", lastRaw: response };

    opts.appendAgent(agentUsed, response);
    if (mode === "explore") {
      exploreResponse = response;
      opts.onExploreCaptured?.(response);
      lastRaw = response;
      lastReason = "explore complete — emit pending";
      continue;
    }
    lastRaw = response;

    const parsed = tryParseWithRuleBasedExtract(
      response,
      opts.parse,
      opts.appendSystem,
      opts.agent.id,
    );
    if (parsed.ok) {
      return { ok: true, value: parsed.value, raw: response };
    }
    lastReason = parsed.reason;

    if (attempt >= 3 && attempt % 2 === 1 && opts.auditor && opts.getActive()?.dedicatedAuditor) {
      const salvage = await runParseSalvage(
        opts.auditor,
        {
          getStopping: opts.getStopping,
          appendSystem: opts.appendSystem,
          appendAgent: (a, t) => opts.appendAgent(a, t),
          promptPlannerSafely: (agent, promptText, agentName, ollamaFormat) =>
            opts.promptPlannerSafely(agent, promptText, agentName ?? "swarm", ollamaFormat),
          getActive: opts.getActive,
          jsonSchema: REPLANNER_JSON_SCHEMA,
        },
        {
          kind: "replanner",
          parseError: lastReason,
          rawOutput: response,
          attempt,
        },
      );
      if (salvage) {
        const salvaged = opts.parse(salvage.json);
        if (salvaged.ok) {
          opts.appendSystem(`[${opts.agent.id}] replan auditor salvage succeeded.`);
          return { ok: true, value: salvaged.value, raw: salvage.json };
        }
      }
    }
  }

  return { ok: false, reason: lastReason, lastRaw };
}