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

const PLACEHOLDER_HOST_RE =
  /example\.com|your-org|your_repo|localhost|127\.0\.0\.1|file:\/\//i;

/**
 * Extract https URLs from text (for citation intersection checks).
 */
export function extractHttpsUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s)\]>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const u = m[0]!.replace(/[.,;:]+$/, "");
    if (!PLACEHOLDER_HOST_RE.test(u)) out.push(u);
  }
  return out;
}

/**
 * RR-C D6: usable research brief.
 * When toolTraceUrls is provided, require at least one non-placeholder
 * https URL that also appeared in tool results (cuts hallucinated citations).
 */
export function isUsableResearchBrief(
  raw: string,
  toolTraceUrls?: readonly string[],
): boolean {
  const text = visibleResearchText(raw);
  if (looksLikeWorkerJsonHunks(raw)) return false;
  if (text.length < 80) return false;
  const urlsInText = extractHttpsUrls(text);
  const hasUrl = urlsInText.length > 0;
  const bulletLines = text.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l));
  const hasBullets = bulletLines.length >= 2;
  const intentOnly =
    /^(let me|i'll start|i will start|first,? i)/i.test(text.slice(0, 120))
    && !hasUrl
    && bulletLines.length === 0;
  if (intentOnly) return false;

  if (toolTraceUrls && toolTraceUrls.length > 0) {
    const toolSet = new Set(
      toolTraceUrls
        .map((u) => u.trim())
        .filter((u) => u.startsWith("http") && !PLACEHOLDER_HOST_RE.test(u)),
    );
    if (toolSet.size === 0) {
      // Tools ran but produced no usable URLs — fall back to text heuristics.
      return hasUrl || (hasBullets && text.length >= 160);
    }
    const intersect = urlsInText.some((u) => {
      if (toolSet.has(u)) return true;
      // Host-level match (tool may return landing, brief cites path).
      try {
        const host = new URL(u).hostname;
        for (const t of toolSet) {
          try {
            if (new URL(t).hostname === host) return true;
          } catch {
            /* */
          }
        }
      } catch {
        /* */
      }
      return false;
    });
    return intersect;
  }

  return hasUrl || (hasBullets && text.length >= 160);
}