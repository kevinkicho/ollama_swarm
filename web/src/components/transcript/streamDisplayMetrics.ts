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

function liveCharCount(parts: StreamDisplayParts): string {
  const n = parts.outputChars > 0 ? parts.outputChars : parts.thinkingChars;
  return n > 0 ? `${n.toLocaleString()} chars · ` : "";
}

/** Live subtitle while the model is still streaming. */
export function streamLiveSubtitle(
  parts: StreamDisplayParts,
  sinceLastTextMs: number,
  stalled: boolean,
  elapsedMs: number,
): string {
  const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
  const elapsed = `${elapsedSec}s`;
  const chars = liveCharCount(parts);
  if (stalled) {
    return `⚠ stalled ${Math.round(sinceLastTextMs / 1000)}s · ${chars}${elapsed}…`;
  }
  const thinkingOnly = parts.outputChars === 0 && parts.thinkingChars > 0;
  if (thinkingOnly) {
    return `reasoning · ${parts.thinkingChars.toLocaleString()} chars · ${elapsed}…`;
  }
  if (sinceLastTextMs < 2000) return `writing · ${chars}${elapsed}…`;
  if (sinceLastTextMs < 10_000) {
    return `paused ${Math.round(sinceLastTextMs / 1000)}s · ${chars}${elapsed}…`;
  }
  return `deep reasoning ${Math.round(sinceLastTextMs / 1000)}s · ${chars}${elapsed}…`;
}

/** Subtitle for dock slots waiting before streaming starts. */
export function streamWaitingSubtitle(
  elapsedMs: number,
  opts: {
    label?: string;
    phase?: "queued" | "waiting" | "retrying";
    reason?: string;
    modelHint?: string;
  } = {},
): string {
  const sec = Math.max(0, Math.round(elapsedMs / 1000));
  if (opts.phase === "retrying") {
    return opts.reason ? `retrying ${sec}s · ${opts.reason}` : `retrying ${sec}s…`;
  }
  const task = opts.label?.trim() ?? "prompt";
  // Do not claim "provider stall" / "not responding" — long TTFT is normal
  // for cloud models and pure-think workers (a12daea8). The provider is often
  // still generating; we simply have no first token yet.
  if (sec >= 120) return `${task} · ${sec}s · waiting for first token…`;
  if (sec >= 60) return `${task} · ${sec}s · no bytes yet…`;
  return `${task} · ${sec}s…`;
}