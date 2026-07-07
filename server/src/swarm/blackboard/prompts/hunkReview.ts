import { parseJsonEnvelope } from "@ollama-swarm/shared/parseAgentJson";

export type HunkReviewParseResult =
  | { ok: true; approve: boolean; reason: string }
  | { ok: false; reason: string };

export function parseHunkReviewResponse(raw: string): HunkReviewParseResult {
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return { ok: false, reason: envelope.reason };
  }
  const parsed = envelope.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "expected top-level JSON object with approve + reason" };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.approve !== "boolean") {
    return { ok: false, reason: "approve must be a boolean" };
  }
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  return {
    ok: true,
    approve: o.approve,
    reason: reason || (o.approve ? "Approved by auditor review" : "Rejected by auditor review"),
  };
}

export function buildHunkReviewRepairPrompt(previous: string, parseError: string): string {
  return [
    "Your previous hunk-review response could not be parsed.",
    `Parser error: ${parseError}`,
    "",
    "Respond now with ONLY a JSON object:",
    '{ "approve": true | false, "reason": "<concise 1-2 sentence justification>" }',
    "",
    "--- BEGIN PREVIOUS RESPONSE ---",
    previous.slice(0, 4000),
    "--- END PREVIOUS RESPONSE ---",
  ].join("\n");
}