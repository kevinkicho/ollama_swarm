import { extractThinkTags } from "../../../../shared/src/extractThinkTags";
import { extractToolCallMarkers } from "../../../../shared/src/extractToolCallMarkers";

const SEMANTICALLY_EMPTY_RE = /^\s*[\[\]{}]+\s*$/;

export type StreamDisplayParts = {
  /** Visible output after think-tag + pseudo-tool-call strip (matches finalized bubbles). */
  finalText: string;
  thoughts: string;
  toolCalls: string[];
  outputChars: number;
  thinkingChars: number;
  rawChars: number;
};

/**
 * Split raw SSE streaming buffer into output vs thinking.
 * extractThinkTags falls back to the full raw string when think blocks
 * are the only content — treat that as zero visible output so char
 * counts match what the user sees in the dock body.
 */
export function streamDisplayParts(raw: string): StreamDisplayParts {
  const { thoughts, finalText: postThink } = extractThinkTags(raw);
  const thinkOnly =
    thoughts.trim().length > 0 &&
    (postThink === raw || postThink.includes("</think>"));
  const { toolCalls, finalText: rawFinal } = extractToolCallMarkers(
    thinkOnly ? "" : postThink,
  );
  const finalText =
    thinkOnly || SEMANTICALLY_EMPTY_RE.test(rawFinal) ? "" : rawFinal;
  return {
    finalText,
    thoughts,
    toolCalls,
    outputChars: finalText.trim().length,
    thinkingChars: thoughts.trim().length,
    rawChars: raw.length,
  };
}

/** Subtitle for a completed streaming slot — counts output chars, not hidden reasoning. */
export function streamDoneSubtitle(parts: StreamDisplayParts, totalSec: number): string {
  return `done · ${parts.outputChars.toLocaleString()} chars · ${totalSec}s total`;
}

/** Live subtitle while the model is still streaming. */
export function streamLiveSubtitle(
  parts: StreamDisplayParts,
  sinceLastTextMs: number,
  stalled: boolean,
): string {
  if (stalled) {
    return `⚠ stalled ${Math.round(sinceLastTextMs / 1000)}s…`;
  }
  const thinkingOnly = parts.outputChars === 0 && parts.thinkingChars > 0;
  if (thinkingOnly) {
    return `reasoning · ${parts.thinkingChars.toLocaleString()} chars (hidden)…`;
  }
  if (sinceLastTextMs < 2000) return "writing…";
  if (sinceLastTextMs < 10_000) {
    return `thinking ${Math.round(sinceLastTextMs / 1000)}s…`;
  }
  return `deep reasoning ${Math.round(sinceLastTextMs / 1000)}s…`;
}