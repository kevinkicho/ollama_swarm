/**
 * Deterministic stream triage ("third eye") — replaces the LLM think-guard referee.
 *
 * Looks at partial stream evidence after a think-guard abort (or pure-think /
 * empty JSON) and classifies: loop | slow_progress | ready_to_emit | needs_tools.
 * Dispatches: force_emit / one continuation / fail — no second model call.
 *
 * @see docs/design/think-guard-referee-checkpoint.md (historical)
 */

import { extractThinkTags } from "./extractThinkTags.js";
import { isPureThinkNoJson } from "./parseAgentJson.js";
import { stripForJsonParse } from "./stripAgentText.js";
import type { ThinkGuardVerdict, ThinkGuardVerdictKind } from "./thinkGuardReferee.js";
import { clipThinkTail } from "./thinkGuardReferee.js";

export type StreamTriageAction = "force_emit" | "one_continuation" | "fail" | "class_repair";

export interface StreamTriageInput {
  partialText: string;
  thinkChars?: number;
  thinkElapsedMs?: number;
  /** Soft=1 / hard=2 think-guard tier when from abort. */
  tier?: 1 | 2;
  repetition?: { repeats: number; rLen: number } | null;
  abortReason?: string;
  /** free | json — when json, pure-think maps to class_repair / force salvage. */
  formatExpect?: "json" | "free";
  /** recovery loop attempt number (planner emit recovery). */
  recoveryAttempt?: number;
  lastFailReason?: string;
}

export interface StreamTriageResult {
  action: StreamTriageAction;
  verdict: ThinkGuardVerdict;
  /** Deterministic brief from think tail / stripped body (not LLM). */
  salvageBrief?: string;
  reason: string;
}

const LONG_THINK_FORCE_EMIT = 80_000;
const HARD_LOOP_REPEATS = 5;
const MIN_SALVAGE_CHARS = 40;

/** Clip think tail + post-think body into a salvage brief for emit-only retry. */
export function buildDeterministicSalvageBrief(
  partialText: string,
  maxChars = 4_000,
): string | undefined {
  if (!partialText?.trim()) return undefined;
  const { thoughts, finalText } = extractThinkTags(partialText);
  const body = stripForJsonParse(partialText).trim();
  const thinkTail = thoughts.trim() ? clipThinkTail(partialText, Math.min(maxChars, 3_000)) : "";
  const final = (finalText || body).trim();
  const parts: string[] = [];
  if (final && final.length >= 20 && final !== thoughts.trim()) {
    parts.push(final.slice(0, maxChars));
  } else if (thinkTail) {
    parts.push(thinkTail.slice(0, maxChars));
  }
  const joined = parts.join("\n\n").trim();
  return joined.length >= MIN_SALVAGE_CHARS ? joined.slice(0, maxChars) : undefined;
}

function baseVerdict(
  kind: ThinkGuardVerdictKind,
  confidence: ThinkGuardVerdict["confidence"],
  rationale: string,
  suggestedAction?: ThinkGuardVerdict["suggestedAction"],
  salvageableBrief?: string,
): ThinkGuardVerdict {
  return {
    verdict: kind,
    confidence,
    rationale: rationale.slice(0, 240),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(salvageableBrief ? { salvageableBrief: salvageableBrief.slice(0, 4000) } : {}),
  };
}

/**
 * Core third-eye: map abort / pure-think / empty-JSON evidence → action.
 * Pure synchronous — safe on hot paths.
 */
export function triageStreamEvidence(input: StreamTriageInput): StreamTriageResult {
  const partial = input.partialText ?? "";
  const thinkChars =
    input.thinkChars
    ?? (extractThinkTags(partial).thoughts.trim().length || partial.length);
  const rep = input.repetition;
  const hardLoop = !!(rep && rep.repeats >= HARD_LOOP_REPEATS);
  const reasonLower = (input.abortReason ?? input.lastFailReason ?? "").toLowerCase();
  const salvage = buildDeterministicSalvageBrief(partial);
  // Do not match think-guard hard-abort reasons ("think-only stream exceeded N chars") —
  // those are length/time caps, not format failures.
  const formatHint =
    /format\/provider|pure\s*<think>|json format sniff|json parse failed|unexpected token|no json object found/i.test(
      reasonLower,
    );
  // Pure-think is a *short* wrong-format failure mode (emit-only / format:json),
  // not every long DeepSeek explore that lives inside <think> tags.
  const pureThinkShort =
    (isPureThinkNoJson(partial) || formatHint)
    && thinkChars < LONG_THINK_FORCE_EMIT
    && (input.formatExpect === "json" || formatHint || thinkChars < 8_000);

  // 1) Hard repetitive loop with nothing to salvage → fail closed
  if (hardLoop && !salvage) {
    return {
      action: "fail",
      verdict: baseVerdict("loop", "high", "Hard repetitive think tail — no salvageable content", "abort"),
      reason: "hard_loop_no_salvage",
    };
  }

  // 2) Hard loop but we have a brief → force emit salvage once
  if (hardLoop && salvage) {
    return {
      action: "force_emit",
      verdict: baseVerdict(
        "loop",
        "medium",
        "Repetitive think with salvageable brief — force emit",
        "force_emit",
        salvage,
      ),
      salvageBrief: salvage,
      reason: "hard_loop_with_salvage",
    };
  }

  // 3) Long think stream → force emit (preserve paid tokens). Before pure-think.
  if (thinkChars >= LONG_THINK_FORCE_EMIT) {
    return {
      action: "force_emit",
      verdict: baseVerdict(
        "ready_to_emit",
        "medium",
        `Long think stream (${thinkChars.toLocaleString()} chars) — salvage via emit`,
        "force_emit",
        salvage,
      ),
      salvageBrief: salvage,
      reason: "long_think_force_emit",
    };
  }

  // 4) Recovery stall after multiple attempts with partial → force emit
  if ((input.recoveryAttempt ?? 0) >= 2 && (salvage || partial.trim().length >= MIN_SALVAGE_CHARS)) {
    return {
      action: "force_emit",
      verdict: baseVerdict(
        "ready_to_emit",
        "medium",
        `Recovery attempt ${input.recoveryAttempt}: salvage partial and force emit`,
        "force_emit",
        salvage,
      ),
      salvageBrief: salvage ?? partial.slice(0, 4000),
      reason: "recovery_force_emit",
    };
  }

  // 5) Pure think / JSON format failure (short) → class repair
  if (pureThinkShort) {
    if (salvage || partial.trim().length >= MIN_SALVAGE_CHARS) {
      return {
        action: "class_repair",
        verdict: baseVerdict(
          "ready_to_emit",
          "medium",
          "Pure think / no JSON envelope — force structured emit",
          "force_emit",
          salvage,
        ),
        salvageBrief: salvage ?? partial.slice(0, 4000),
        reason: "pure_think_force_emit",
      };
    }
    return {
      action: "fail",
      verdict: baseVerdict("loop", "medium", "Empty pure-think stream — nothing to salvage", "abort"),
      reason: "pure_think_empty",
    };
  }

  // 6) Moderate abort with partial → one continuation
  if (partial.trim().length >= MIN_SALVAGE_CHARS) {
    return {
      action: "one_continuation",
      verdict: baseVerdict(
        "slow_progress",
        "low",
        "Interrupted think stream — one continuation to emit structured output",
        "extend_budget",
        salvage,
      ),
      salvageBrief: salvage,
      reason: "one_continuation",
    };
  }

  // 7) Nothing usable
  return {
    action: "fail",
    verdict: baseVerdict("loop", "low", "No salvageable stream content", "abort"),
    reason: "empty_partial",
  };
}

/** Map triage result → handler dispatch shape (continuation / partial / rethrow). */
export function triageToHandlerAction(
  triage: StreamTriageResult,
  partialText: string,
  continuationAlreadyUsed: boolean,
): {
  type: "return_partial" | "continuation_prompt" | "rethrow";
  text?: string;
  prompt?: string;
  verdict: ThinkGuardVerdict;
} {
  if (triage.action === "fail") {
    return { type: "rethrow", verdict: triage.verdict };
  }

  if (triage.action === "one_continuation" && !continuationAlreadyUsed) {
    const tail = clipThinkTail(partialText, 8_000);
    const brief = triage.salvageBrief?.trim();
    const prompt = [
      "Your prior think-only stream was interrupted after long reasoning.",
      `Triage: ${triage.verdict.verdict} (${triage.verdict.confidence}) — ${triage.verdict.rationale}`,
      brief ? `Salvageable brief:\n${brief}` : "",
      "Continue from your reasoning and produce the required structured JSON output now.",
      "Do not restart a full repo exploration from scratch.",
      tail ? `Recent reasoning tail:\n${tail}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { type: "continuation_prompt", prompt, verdict: triage.verdict };
  }

  // force_emit, class_repair, or second continuation → return partial for salvage path
  return {
    type: "return_partial",
    text: partialText,
    verdict: {
      ...triage.verdict,
      suggestedAction: triage.verdict.suggestedAction ?? "force_emit",
      salvageableBrief: triage.salvageBrief ?? triage.verdict.salvageableBrief,
    },
  };
}
