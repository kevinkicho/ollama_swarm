/**
 * Single authority for agent raw text → transcript-ready fields.
 *
 * Every runner historically called stripAgentText (or worse, raw text)
 * independently. Run 9f449937 showed the cost: 298k-char loops persisted
 * into summary.json, WS, and debug logs even when cloud usage stayed modest.
 *
 * This module is the only place that should grow new post-stream policy:
 * strip think/tools → collapse loops → hard-cap storage → anomaly report.
 */

import { stripAgentText, type StrippedAgentText } from "./stripAgentText.js";
import { collapsePhraseLoop, detectPhraseLoop } from "./streamLoopDetect.js";

/** Hard ceiling for agent bubble body in transcript / summary (post-collapse). */
export const TRANSCRIPT_FINAL_TEXT_HARD_MAX = 48_000;
/** Thoughts field also capped so salvage panels stay usable. */
export const TRANSCRIPT_THOUGHTS_HARD_MAX = 24_000;

export type AgentOutputAnomaly =
  | {
      kind: "phrase_loop_collapsed";
      count: number;
      phraseLen: number;
      coveredRatio: number;
      removedChars: number;
    }
  | { kind: "hard_truncated"; field: "finalText" | "thoughts"; originalChars: number }
  | { kind: "empty_after_strip"; rawChars: number };

export interface FinalizeAgentOutputOptions {
  /** Override final-text hard max (default TRANSCRIPT_FINAL_TEXT_HARD_MAX). */
  maxFinalChars?: number;
  maxThoughtChars?: number;
  /**
   * worker: if body has no JSON envelope after strip, prefer a short
   * placeholder over dumping reasoning prose into a hunks bubble.
   */
  role?: "worker" | "general";
}

export interface FinalizedAgentOutput extends StrippedAgentText {
  anomalies: AgentOutputAnomaly[];
  stats: {
    rawChars: number;
    finalChars: number;
    thoughtChars: number;
  };
}

function hardCap(
  text: string,
  max: number,
  field: "finalText" | "thoughts",
): { text: string; anomaly?: AgentOutputAnomaly } {
  if (text.length <= max) return { text };
  const head = Math.floor(max * 0.45);
  const tail = max - head - 90;
  return {
    text:
      text.slice(0, head) +
      `\n…[truncated ${field}: ${text.length.toLocaleString()} → ${max.toLocaleString()} chars]…\n` +
      text.slice(-Math.max(0, tail)),
    anomaly: { kind: "hard_truncated", field, originalChars: text.length },
  };
}

function looksLikeJsonEnvelope(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if (/```(?:json)?/i.test(t) && /[{[]/.test(t)) return true;
  return /"hunks"\s*:/.test(t) || /"todos"\s*:/.test(t) || /"missionStatement"\s*:/.test(t);
}

/**
 * Canonical transform: raw provider text → safe transcript fields + anomalies.
 */
export function finalizeAgentOutput(
  raw: string,
  opts: FinalizeAgentOutputOptions = {},
): FinalizedAgentOutput {
  const rawChars = raw?.length ?? 0;
  const anomalies: AgentOutputAnomaly[] = [];
  const stripped = stripAgentText(raw ?? "");

  let finalText = stripped.finalText;
  let thoughts = stripped.thoughts;
  const toolCalls = stripped.toolCalls;

  if (stripped.loopCollapsed) {
    const hit = detectPhraseLoop(raw);
    anomalies.push({
      kind: "phrase_loop_collapsed",
      count: hit?.count ?? 0,
      phraseLen: hit?.phraseLen ?? 0,
      coveredRatio: hit?.coveredRatio ?? 0,
      removedChars: Math.max(0, rawChars - finalText.length),
    });
  } else if (finalText.length >= 8_000) {
    // Defense if stripAgentText collapse threshold drifts
    const c = collapsePhraseLoop(finalText, { minLenToCollapse: 8_000, maxKeep: 2 });
    if (c.collapsed) {
      finalText = c.text;
      anomalies.push({
        kind: "phrase_loop_collapsed",
        count: c.hit?.count ?? 0,
        phraseLen: c.hit?.phraseLen ?? 0,
        coveredRatio: c.hit?.coveredRatio ?? 0,
        removedChars: c.removedChars,
      });
    }
  }

  if (opts.role === "worker" && finalText.length > 400 && !looksLikeJsonEnvelope(finalText)) {
    const salvage = finalText.slice(0, 280).replace(/\s+/g, " ").trim();
    finalText =
      `(worker response had no JSON hunk envelope after strip — ${finalText.length.toLocaleString()} chars suppressed)\n` +
      `Salvage: ${salvage}…`;
  }

  const maxFinal = opts.maxFinalChars ?? TRANSCRIPT_FINAL_TEXT_HARD_MAX;
  const maxThought = opts.maxThoughtChars ?? TRANSCRIPT_THOUGHTS_HARD_MAX;
  const capF = hardCap(finalText, maxFinal, "finalText");
  finalText = capF.text;
  if (capF.anomaly) anomalies.push(capF.anomaly);
  const capT = hardCap(thoughts, maxThought, "thoughts");
  thoughts = capT.text;
  if (capT.anomaly) anomalies.push(capT.anomaly);

  if (!finalText.trim() && rawChars > 0 && toolCalls.length === 0 && !thoughts.trim()) {
    anomalies.push({ kind: "empty_after_strip", rawChars });
  }

  return {
    finalText,
    thoughts,
    toolCalls,
    loopCollapsed: anomalies.some((a) => a.kind === "phrase_loop_collapsed"),
    anomalies,
    stats: {
      rawChars,
      finalChars: finalText.length,
      thoughtChars: thoughts.length,
    },
  };
}

/** One-line system bubble when finalize found something operators should notice. */
export function formatFinalizeAnomalyLine(
  agentId: string,
  anomalies: AgentOutputAnomaly[],
  stats: FinalizedAgentOutput["stats"],
): string | null {
  if (anomalies.length === 0) return null;
  const parts = anomalies.map((a) => {
    if (a.kind === "phrase_loop_collapsed") {
      return `collapsed ~${a.count}×${a.phraseLen}c loop (−${a.removedChars.toLocaleString()} chars)`;
    }
    if (a.kind === "hard_truncated") {
      // Storage cap for transcript bubbles — does not cut the model mid-generation
      // and does not replace the raw buffer used for JSON apply (see parse path).
      return `hard-truncated ${a.field} from ${a.originalChars.toLocaleString()} (transcript storage cap)`;
    }
    return a.kind;
  });
  return (
    `[stream-integrity] ${agentId}: ${parts.join("; ")} ` +
    `(raw ${stats.rawChars.toLocaleString()} → final ${stats.finalChars.toLocaleString()})`
  );
}

/** Structured summary for SystemBubble + transcript filters. */
export function streamIntegritySummaryFromAnomalies(
  agentId: string,
  anomalies: AgentOutputAnomaly[],
  stats: FinalizedAgentOutput["stats"],
  detail: string,
): {
  kind: "stream_integrity";
  agentId: string;
  anomalyKinds: string[];
  rawChars: number;
  finalChars: number;
  detail: string;
} {
  return {
    kind: "stream_integrity",
    agentId,
    anomalyKinds: anomalies.map((a) => a.kind),
    rawChars: stats.rawChars,
    finalChars: stats.finalChars,
    detail: detail.slice(0, 500),
  };
}
