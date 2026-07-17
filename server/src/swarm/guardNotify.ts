// Shared guard-trip notifications: system line + optional Brain suggestion
// with a one-click RECONFIG payload for the UI.
//
// Called for empty-output, plan-empty, resource caps, and audit/tier stuck.
// These are the primary whole-run gates (see docs/decisions.md 2026-07-10).

import type { TranscriptEntrySummary } from "../types.js";

export type GuardTripKind =
  | "output-empty"
  | "plan-empty"
  | "empty-execution"
  | "wall-clock"
  | "token-budget"
  | "quota"
  | "audit-stuck"
  | "tier-stuck";

export interface GuardReconfigHints {
  extendWallClockCapMin?: number;
  extendRounds?: number;
  extendTokenBudget?: number;
}

export interface GuardNotifyOpts {
  kind: GuardTripKind;
  /** Short machine detail (often earlyStopDetail). */
  detail: string;
  runId?: string;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  getBrainService?: () =>
    | {
        injectSuggestion?: (
          runId: string,
          s: { title: string; text: string; category?: string },
        ) => void;
      }
    | null
    | undefined;
  /** Override default reconfig suggestions. */
  reconfig?: GuardReconfigHints | null;
  /** Skip Brain inject (system line only). */
  skipBrain?: boolean;
}

function defaultReconfig(kind: GuardTripKind): GuardReconfigHints | null {
  switch (kind) {
    case "wall-clock":
      return { extendWallClockCapMin: 15 };
    case "token-budget":
      return { extendTokenBudget: 50_000 };
    case "output-empty":
    case "plan-empty":
    case "empty-execution":
      // Empty standup / 0 todos: give more discussion rounds before hard stop.
      return { extendRounds: 2 };
    case "audit-stuck":
    case "tier-stuck":
      return { extendWallClockCapMin: 10, extendRounds: 1 };
    case "quota":
      return null; // wait / change model — not a simple extend
    default:
      return null;
  }
}

function titleFor(kind: GuardTripKind): string {
  switch (kind) {
    case "output-empty":
      return "Run may be stuck (empty agent output)";
    case "plan-empty":
      return "Run may be stuck (empty plan)";
    case "empty-execution":
      return "Empty execution (no standup todos)";
    case "wall-clock":
      return "Wall-clock cap reached";
    case "token-budget":
      return "Token budget reached";
    case "quota":
      return "Provider quota wall";
    case "audit-stuck":
      return "Audit stuck on same criteria";
    case "tier-stuck":
      return "No new board progress";
    default:
      return "Guard tripped";
  }
}

function bodyFor(kind: GuardTripKind, detail: string, reconfig: GuardReconfigHints | null): string {
  const lines = [
    `Guard: ${kind}`,
    `Detail: ${detail}`,
    "",
    "This stop is a resource cap or empty/junk-output gate (primary loop policy).",
    "Agents re-reading prior logs with shared vocabulary is normal productive work; empty/junk turns or caps are the signal here.",
  ];
  if (reconfig && Object.keys(reconfig).length > 0) {
    lines.push("", `RECONFIG: ${JSON.stringify(reconfig)}`);
    lines.push("Apply the RECONFIG chip below (or ask Brain) to extend limits if the run was still productive.");
  } else if (kind === "quota") {
    lines.push("", "Quota: wait for reset, switch provider/model, or stop and resume later.");
  }
  return lines.join("\n");
}

/**
 * Best-effort Brain suggestion (violet chip + optional RECONFIG). Falls back
 * to a system line with the same summary kind when Brain is unavailable.
 * Avoids double-append when injectSuggestion already writes the transcript.
 */
export function notifyGuardTrip(opts: GuardNotifyOpts): void {
  const reconfig =
    opts.reconfig === null ? null : (opts.reconfig ?? defaultReconfig(opts.kind));
  const title = titleFor(opts.kind);
  const text = bodyFor(opts.kind, opts.detail, reconfig);
  const shortLine = `[guard:${opts.kind}] ${opts.detail}`;

  let injected = false;
  if (!opts.skipBrain) {
    const runId = opts.runId?.trim();
    if (runId) {
      try {
        const brain = opts.getBrainService?.();
        if (brain?.injectSuggestion) {
          brain.injectSuggestion(runId, {
            title,
            text: `${shortLine}\n\n${text}`,
            category: "recommendation",
          });
          injected = true;
        }
      } catch {
        // fall through to appendSystem
      }
    }
  }

  if (!injected) {
    opts.appendSystem(`${shortLine}\n\n${text}`, {
      kind: "brain_suggestion",
      title,
      category: "recommendation",
    } as TranscriptEntrySummary);
  }
}
