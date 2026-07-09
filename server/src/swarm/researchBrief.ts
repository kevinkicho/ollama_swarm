import { extractThinkTags } from "../../../shared/src/extractThinkTags.js";

/** Strip chain-of-thought wrappers before judging visible research output. */
export function visibleResearchText(raw: string): string {
  const { finalText } = extractThinkTags(raw);
  return finalText.trim();
}

/**
 * Reject intent-only stubs ("let me gather…") that satisfy length but carry
 * no citations or structured findings.
 */
/** Worker JSON hunks smuggled into the literature phase (before prose notes). */
export function looksLikeWorkerJsonHunks(raw: string): boolean {
  const text = visibleResearchText(raw);
  if (!/^\s*\[/.test(text)) return false;
  return /"(op|file|content|search|replace|hunks)"\s*:/.test(text);
}

export function isUsableResearchBrief(raw: string): boolean {
  const text = visibleResearchText(raw);
  if (looksLikeWorkerJsonHunks(raw)) return false;
  if (text.length < 80) return false;
  const hasUrl = /https?:\/\/\S+/i.test(text);
  const bulletLines = text.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l));
  const hasBullets = bulletLines.length >= 2;
  const intentOnly =
    /^(let me|i'll start|i will start|first,? i)/i.test(text.slice(0, 120))
    && !hasUrl
    && bulletLines.length === 0;
  if (intentOnly) return false;
  return hasUrl || (hasBullets && text.length >= 160);
}