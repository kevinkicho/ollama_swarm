// 2026-05-02 (persistence lever #2 first-cut): debounced JSON snapshot
// of the active run's transcript + amendments + phase to
// <clonePath>/run-state.json so a server restart doesn't drop in-flight
// chat history + planner nudges on the floor.
//
// SCOPE OF THIS FIRST-CUT:
//   - Write side ONLY. Every meaningful event (transcript_append,
//     swarm_state, agent_state, etc.) schedules a debounced write.
//   - Atomic via write-temp-then-rename.
//   - Never throws out of the broadcast path. Persistence failure is
//     logged once, then silenced for the run.
//
// DEFERRED TO ITS OWN SESSION:
//   - Recovery (Orchestrator scans on startup, prompts user "resume
//     this run?", restores transcript + amendments into a fresh runner).
//   - The recovery flow is the harder half — it needs UX design (auto-
//     resume vs prompt) AND careful state-machine work (the runner
//     mid-prompt at restart can't be resumed cleanly; only the user-
//     visible state can).
//
// .gitignored — these files are operational state, not source.

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 500;
const SCHEMA_VERSION = 1;

export interface PersistedRunState {
  schemaVersion: number;
  runId: string;
  preset: string;
  phase: string;
  startedAt: number;
  lastEventAt: number;
  /** Serialized transcript entries — exactly what the runner has in
   *  memory. Recovery (deferred) restores this into a fresh runner. */
  transcript: unknown[];
  /** Active amendments buffer for this run. */
  amendments: Array<{ ts: number; text: string }>;
}

export interface SnapshotInput {
  runId: string;
  preset: string;
  phase: string;
  startedAt: number;
  transcript: unknown[];
  amendments: Array<{ ts: number; text: string }>;
}

/** RunStatePersister — one instance per active run. Owned by the
 *  orchestrator; constructed at run-start, stopped at run-end. */
export class RunStatePersister {
  private readonly clonePath: string;
  private readonly statePath: string;
  private readonly tmpPath: string;
  private timer: NodeJS.Timeout | null = null;
  private pendingSnapshot: SnapshotInput | null = null;
  private silenceErrors = false;
  private writeCount = 0;

  constructor(clonePath: string) {
    this.clonePath = clonePath;
    this.statePath = path.join(clonePath, "run-state.json");
    this.tmpPath = `${this.statePath}.tmp`;
  }

  /** Schedule a debounced write. Multiple calls within DEBOUNCE_MS
   *  collapse to one fsync. Last-snapshot-wins. */
  schedule(snapshot: SnapshotInput): void {
    this.pendingSnapshot = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DEBOUNCE_MS);
  }

  /** Force an immediate write (e.g. at run-end so terminal state isn't
   *  trapped behind the debounce). Pure no-op when no pending snapshot. */
  flush(): void {
    if (!this.pendingSnapshot) return;
    const snap = this.pendingSnapshot;
    this.pendingSnapshot = null;
    const state: PersistedRunState = {
      schemaVersion: SCHEMA_VERSION,
      runId: snap.runId,
      preset: snap.preset,
      phase: snap.phase,
      startedAt: snap.startedAt,
      lastEventAt: Date.now(),
      transcript: snap.transcript,
      amendments: snap.amendments,
    };
    try {
      // Atomic via tmp + rename. Atomic-rename keeps any concurrent
      // reader from seeing a half-written file.
      mkdirSync(this.clonePath, { recursive: true });
      writeFileSync(this.tmpPath, JSON.stringify(state, null, 2), "utf8");
      renameSync(this.tmpPath, this.statePath);
      this.writeCount += 1;
    } catch (err) {
      if (!this.silenceErrors) {
        console.error(
          `[RunStatePersister] write failed at ${this.statePath}: ${err instanceof Error ? err.message : String(err)} — silencing further errors for this run`,
        );
        this.silenceErrors = true;
      }
    }
  }

  /** Cancel any pending write + flush the last snapshot. Called at
   *  run-end so terminal state is on disk before the persister is
   *  dropped. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  /** Diagnostic: how many writes have actually landed. */
  getWriteCount(): number {
    return this.writeCount;
  }
}
