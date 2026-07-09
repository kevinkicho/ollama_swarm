import { extractThinkTags } from "./extractThinkTags.js";

export type ThinkGuardVerdictKind =
  | "loop"
  | "slow_progress"
  | "ready_to_emit"
  | "needs_tools";

export interface ThinkGuardVerdict {
  verdict: ThinkGuardVerdictKind;
  confidence: "low" | "medium" | "high";
  rationale: string;
  suggestedAction?: "extend_budget" | "nudge_emit" | "force_emit" | "abort";
  salvageableBrief?: string;
}

export const THINK_GUARD_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "rationale"],
  properties: {
    verdict: {
      type: "string",
      enum: ["loop", "slow_progress", "ready_to_emit", "needs_tools"],
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    rationale: { type: "string", maxLength: 240 },
    suggestedAction: {
      type: "string",
      enum: ["extend_budget", "nudge_emit", "force_emit", "abort"],
    },
    salvageableBrief: { type: "string", maxLength: 4000 },
  },
} as const;

export interface ThinkGuardRefereeInput {
  taskLabel: string;
  activityKind?: string;
  thinkChars: number;
  thinkElapsedMs: number;
  toolTurnCount?: number;
  repetitionHint?: string;
  partialText: string;
  originalPromptExcerpt?: string;
  thinkTailMaxChars?: number;
  thinkTailMinChars?: number;
}

export function clipThinkTail(
  partialText: string,
  maxChars: number,
  minChars?: number,
): string {
  const { thoughts } = extractThinkTags(partialText);
  const trimmed = thoughts.trim();
  if (!trimmed) return "";
  const cap = Math.max(minChars ?? 0, maxChars);
  return trimmed.length <= cap ? trimmed : trimmed.slice(-cap);
}

export function buildThinkGuardRefereePrompt(input: ThinkGuardRefereeInput): string {
  const tailMax = input.thinkTailMaxChars ?? 12_000;
  const tail = clipThinkTail(input.partialText, tailMax, input.thinkTailMinChars);
  const promptExcerpt = (input.originalPromptExcerpt ?? "").slice(0, 1500);
  return [
    "You are a TRIAGE REFEREE for a long think-only LLM stream that was aborted before structured output.",
    "Decide whether the partial reasoning is a wasteful loop, slow but real progress, or ready to emit JSON.",
    "",
    `Task: ${input.taskLabel}`,
    input.activityKind ? `Activity: ${input.activityKind}` : "",
    `Think chars: ${input.thinkChars.toLocaleString()}`,
    `Think elapsed: ${Math.round(input.thinkElapsedMs / 1000)}s`,
    input.toolTurnCount != null ? `Tool turns so far: ${input.toolTurnCount}` : "",
    input.repetitionHint ? `Repetition hint: ${input.repetitionHint}` : "",
    "",
    promptExcerpt ? `Original prompt excerpt:\n${promptExcerpt}` : "",
    "",
    "Think tail (most recent reasoning):",
    tail || "(empty)",
    "",
    "Respond with JSON only matching the schema.",
    "If salvageable, include salvageableBrief (≤4000 chars) summarizing findings for an emit-only pass.",
    "suggestedAction: extend_budget | nudge_emit | force_emit | abort",
  ].filter(Boolean).join("\n");
}

export function parseThinkGuardVerdict(raw: string): ThinkGuardVerdict | null {
  const text = raw.trim();
  if (!text) return null;
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(text);
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const verdict = parsed.verdict;
      const confidence = parsed.confidence;
      if (
        verdict !== "loop"
        && verdict !== "slow_progress"
        && verdict !== "ready_to_emit"
        && verdict !== "needs_tools"
      ) {
        continue;
      }
      if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
        continue;
      }
      const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
      if (!rationale) continue;
      const out: ThinkGuardVerdict = {
        verdict,
        confidence,
        rationale: rationale.slice(0, 240),
      };
      const action = parsed.suggestedAction;
      if (
        action === "extend_budget"
        || action === "nudge_emit"
        || action === "force_emit"
        || action === "abort"
      ) {
        out.suggestedAction = action;
      }
      if (typeof parsed.salvageableBrief === "string" && parsed.salvageableBrief.trim()) {
        out.salvageableBrief = parsed.salvageableBrief.trim().slice(0, 4000);
      }
      return out;
    } catch {
      // try next
    }
  }
  return null;
}