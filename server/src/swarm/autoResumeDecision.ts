// R5 (2026-05-04): auto-resume decision helper.
//
// findRecoverableRuns / loadSnapshot already exist (RunStatePersister).
// The piece R5 adds is the *policy*: should the server, on startup,
// silently pick a snapshot back up and continue — or just surface it
// to the user and wait for them to click Resume?
//
// Heuristics:
//   - No runConfig in snapshot              → can't auto-resume (skip)
//   - Phase is terminal                     → skip (nothing to resume)
//   - Snapshot too old (default >30 min)    → notify-only (probably
//     stale — user might not want it to auto-restart yesterday's run
//     while they sleep)
//   - Transcript too large (>1000 entries)  → notify-only (long-running
//     resume risks compounding the prior failure)
//   - Otherwise                             → auto-resume
//
// Pure: no I/O. Caller passes the snapshot + the current wall-clock.

import {
  type PersistedRunState,
  isRecoverablePhase,
} from "../services/RunStatePersister.js";

export type AutoResumeAction = "auto-resume" | "notify-only" | "skip";

export interface AutoResumeDecision {
  action: AutoResumeAction;
  reason: string;
}

export interface AutoResumeOptions {
  /** Wall-clock now (ms). */
  now: number;
  /** Older than this → notify-only. Default 30 min. */
  maxAgeMs?: number;
  /** Larger than this → notify-only. Default 1000. */
  maxTranscriptLength?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_MAX_TRANSCRIPT = 1000;

export function decideAutoResume(
  snapshot: PersistedRunState,
  options: AutoResumeOptions,
): AutoResumeDecision {
  const {
    now,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxTranscriptLength = DEFAULT_MAX_TRANSCRIPT,
  } = options;
  if (!isRecoverablePhase(snapshot.phase)) {
    return {
      action: "skip",
      reason: `phase="${snapshot.phase}" is terminal — nothing to resume`,
    };
  }
  if (!snapshot.runConfig) {
    return {
      action: "skip",
      reason: "snapshot lacks runConfig (v1 schema) — cannot reconstruct cfg",
    };
  }
  const ageMs = now - snapshot.lastEventAt;
  if (ageMs < 0) {
    // Clock skew (or restored backup with future ts). Treat as fresh.
    return {
      action: "auto-resume",
      reason: "snapshot timestamp in the future (clock skew?) — proceeding",
    };
  }
  if (ageMs > maxAgeMs) {
    const ageMin = Math.round(ageMs / 60_000);
    return {
      action: "notify-only",
      reason: `snapshot is ${ageMin} min old (> ${Math.round(maxAgeMs / 60_000)} min cap) — surface to user, don't auto-resume`,
    };
  }
  if (snapshot.transcript.length > maxTranscriptLength) {
    return {
      action: "notify-only",
      reason: `transcript has ${snapshot.transcript.length} entries (> ${maxTranscriptLength}) — auto-resume could compound failure`,
    };
  }
  return {
    action: "auto-resume",
    reason: `phase="${snapshot.phase}", age=${Math.round(ageMs / 1000)}s, transcript=${snapshot.transcript.length} entries — safe to auto-resume`,
  };
}
