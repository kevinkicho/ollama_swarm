// Phase 7 Step B: on uncaught exception inside planAndExecute, the runner
// writes <clone>/board-final.json for post-mortem debugging. This module is
// the pure shape-assembly half — given the state the runner has in hand at
// crash time, produce the JSON-ready object. The runner handles the I/O.
//
// Why separate? The serialization contract is the load-bearing part (we
// want a stable shape for tooling to consume), but standing up the full
// runner in a unit test is heavy. Extracting this keeps the contract
// testable without the runner and keeps the runner focused on I/O.

import type { BoardSnapshot } from "./types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { SwarmPhase, TranscriptEntry } from "../../types.js";

// Cap the transcript in the snapshot so a run with thousands of entries
// can't produce a 50 MB board-final.json. The tail is what matters for
// post-mortem — the full transcript is in logs/current.jsonl if deeper
// inspection is needed. 200 is generous vs. any real run we've seen.
export const CRASH_SNAPSHOT_TRANSCRIPT_MAX = 200;

export interface CrashSnapshotInput {
  error: unknown;
  phase: SwarmPhase;
  /** undefined if the crash happened before executing phase began. */
  runStartedAt?: number;
  crashedAt: number;
  /** undefined if crash happened before start() stamped active config. */
  config?: RunConfig;
  board: BoardSnapshot;
  transcript: TranscriptEntry[];
}

export interface CrashSnapshot {
  error: {
    message: string;
    /** Only present when the thrown value was an Error with a stack. */
    stack?: string;
  };
  phase: SwarmPhase;
  runStartedAt?: number;
  crashedAt: number;
  config: RunConfig | null;
  board: BoardSnapshot;
  /** Tail-truncated to at most CRASH_SNAPSHOT_TRANSCRIPT_MAX entries. */
  transcript: TranscriptEntry[];
  /** True iff the original transcript exceeded the cap and was tail-sliced. */
  transcriptTruncated: boolean;
}

export function buildCrashSnapshot(input: CrashSnapshotInput): CrashSnapshot {
  const { error, phase, runStartedAt, crashedAt, config, board, transcript } = input;
  const errMsg = error instanceof Error ? error.message : String(error);
  const errStack = error instanceof Error && error.stack ? error.stack : undefined;
  const truncated = transcript.length > CRASH_SNAPSHOT_TRANSCRIPT_MAX;
  const tail = truncated
    ? transcript.slice(-CRASH_SNAPSHOT_TRANSCRIPT_MAX)
    : transcript;
  return {
    error: errStack ? { message: errMsg, stack: errStack } : { message: errMsg },
    phase,
    runStartedAt,
    crashedAt,
    config: config ?? null,
    board,
    transcript: tail,
    transcriptTruncated: truncated,
  };
}
