// Q7 (2026-05-04): debate-judge swap-sides bias check.
//
// LLM judges are biased toward the more articulate side. To
// surface that bias, run a SECOND judge pass with PRO/CON labels
// SWAPPED in the transcript: the original PRO arguments get
// re-labeled as CON's, and vice versa. If the judge's verdict
// flips, the original verdict was driven by labeling rather than
// substance — flag low confidence + surface the discrepancy.
//
// Pure helpers:
//   - `swapPositionLabels` — relabels a transcript so PRO/CON
//     appear swapped in the judge's view. Pure transformation;
//     doesn't mutate input.
//   - `compareVerdicts` — given the original + swapped verdicts,
//     return a discrepancy descriptor (winner-flipped / confidence-
//     flipped / consistent).
//
// Tradeoffs:
//   - +1 judge prompt per debate (the same judge, different inputs).
//   - When the verdict IS bias-driven, downstream "executeNextAction"
//     work shouldn't fire — the recommendation was driven by
//     labeling, not substance. Honor `consistencyDegraded` in the
//     decision logic.

import type { TranscriptEntry } from "../types.js";
import type { ParsedDebateVerdict } from "./debatePromptHelpers.js";

/** Transform debate transcript so PRO ↔ CON labels are swapped in
 *  every entry's text. Pure; returns a new array; doesn't mutate
 *  inputs. The summary kind tags ("debate_turn") are also flipped
 *  so downstream reads see the swap consistently.
 *
 *  Implementation note: only `agentIndex` (1=PRO, 2=CON, 3=JUDGE)
 *  swaps; the actual text content is left as-is — the judge will
 *  re-evaluate whoever is now labeled "PRO" against whoever is now
 *  labeled "CON". */
export function swapPositionLabels(
  entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
  return entries.map((e) => {
    if (e.role !== "agent") return { ...e };
    if (typeof e.agentIndex !== "number") return { ...e };
    let newIdx = e.agentIndex;
    if (e.agentIndex === 1) newIdx = 2;
    else if (e.agentIndex === 2) newIdx = 1;
    // Judge (idx 3) untouched.
    const out: TranscriptEntry = { ...e, agentIndex: newIdx };
    // Flip summary kind too if it carries a debate_turn role.
    if (
      e.summary &&
      e.summary.kind === "debate_turn" &&
      (e.summary.role === "pro" || e.summary.role === "con")
    ) {
      out.summary = {
        ...e.summary,
        role: e.summary.role === "pro" ? "con" : "pro",
      };
    }
    return out;
  });
}

export type VerdictDiscrepancy =
  | "consistent"
  | "winner-flipped"
  | "confidence-degraded";

export interface VerdictComparison {
  /** Verdict relationship between original + swapped passes. */
  discrepancy: VerdictDiscrepancy;
  /** True when the swap flipped the winner — strongest bias signal. */
  winnerFlipped: boolean;
  /** True when consistent winner but confidence dropped — softer
   *  bias signal. */
  confidenceDegraded: boolean;
  /** Human-readable explanation suitable for the run summary. */
  note: string;
}

const CONFIDENCE_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Compare two verdicts; surface bias signals. Pure. */
export function compareVerdicts(args: {
  original: ParsedDebateVerdict;
  swapped: ParsedDebateVerdict;
}): VerdictComparison {
  const { original, swapped } = args;
  // Define "winner-flipped" carefully:
  //   original=pro, swapped=pro → BIAS (judge picked the same SIDE
  //     even though sides were swapped — i.e., picked whoever was
  //     labeled PRO regardless of substance)
  //   original=pro, swapped=con → CONSISTENT (judge picked the same
  //     SUBSTANCE-arguer, who is now under the CON label)
  //   original=tie, swapped=tie → CONSISTENT
  //   any non-tie ↔ tie change → DEGRADED
  let winnerFlipped = false;
  let confidenceDegraded = false;
  let note: string;
  if (original.winner === "tie" && swapped.winner === "tie") {
    note = "Both passes ruled tie — consistent.";
  } else if (original.winner === "tie" || swapped.winner === "tie") {
    confidenceDegraded = true;
    note = `One pass ruled tie (original=${original.winner}, swapped=${swapped.winner}); judge is uncertain.`;
  } else if (original.winner === swapped.winner) {
    // Same SIDE label won → judge picked by label, not substance.
    winnerFlipped = true;
    note = `Both passes named ${original.winner.toUpperCase()} as winner DESPITE swapped sides — judge appears to favor the ${original.winner.toUpperCase()} label rather than the substance.`;
  } else {
    // Different side labels won → judge picked by substance (the
    // substance-arguer is now under a different label).
    const origRank = CONFIDENCE_RANK[original.confidence] ?? 0;
    const swappedRank = CONFIDENCE_RANK[swapped.confidence] ?? 0;
    if (Math.abs(origRank - swappedRank) >= 1) {
      confidenceDegraded = true;
      note = `Verdicts substantively consistent (winner flipped with the swap, as expected for substance-driven judgment) but confidence dropped from ${original.confidence} → ${swapped.confidence}.`;
    } else {
      note = "Verdicts consistent — winner flipped with the swap, confidence held steady. Judgment appears substance-driven.";
    }
  }
  const discrepancy: VerdictDiscrepancy = winnerFlipped
    ? "winner-flipped"
    : confidenceDegraded
      ? "confidence-degraded"
      : "consistent";
  return { discrepancy, winnerFlipped, confidenceDegraded, note };
}

/** Should the post-verdict "executeNextAction" build phase fire
 *  given the bias check? Skip when winner-flipped (the recommendation
 *  was bias-driven) OR confidence-degraded (uncertainty). Pure. */
export function shouldRunNextActionAfterBiasCheck(
  comparison: VerdictComparison,
): boolean {
  return comparison.discrepancy === "consistent";
}
