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

import {
  writeFileSync,
  renameSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 500;
// T-Item-Recover (2026-05-04): bumped from 1 → 2. v2 adds the
// optional `runConfig` field; v1 snapshots are still readable +
// listable, just not resumable (the recover endpoint refuses
// without cfg).
const SCHEMA_VERSION = 2;

/** Subset of the run's RunConfig persisted in the snapshot, just
 *  enough to reconstruct a runnable cfg for /api/swarm/recover.
 *  Per-run knobs the user might have set (e.g., parallel-debate
 *  streams, custom roles) ride along verbatim so the resumed run
 *  matches the original. */
export interface PersistedRunConfig {
  preset: string;
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
  /** Catch-all for the rest of RunConfig — preserved verbatim so
   *  preset-specific knobs survive the round-trip. The recover
   *  endpoint feeds this back into /api/swarm/start. */
  extras?: Record<string, unknown>;
}

export interface PersistedRunState {
  schemaVersion: number;
  runId: string;
  preset: string;
  phase: string;
  startedAt: number;
  lastEventAt: number;
  /** Serialized transcript entries — exactly what the runner has in
   *  memory. Surfaced by the recover endpoint so the UI can show
   *  the prior run's history; not auto-injected into the new
   *  runner (runners reset transcript on start). */
  transcript: unknown[];
  /** Active amendments buffer for this run. */
  amendments: Array<{ ts: number; text: string }>;
  /** T-Item-Recover (2026-05-04): cfg snapshot for resume. Optional
   *  for back-compat with v1 snapshots; absent → not resumable. */
  runConfig?: PersistedRunConfig;
}

export interface SnapshotInput {
  runId: string;
  preset: string;
  phase: string;
  startedAt: number;
  transcript: unknown[];
  amendments: Array<{ ts: number; text: string }>;
  /** T-Item-Recover (2026-05-04): include the cfg so the snapshot
   *  is resumable. Optional — the orchestrator passes it; the
   *  persister forwards it as-is. */
  runConfig?: PersistedRunConfig;
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
    // 2026-05-04 fix: write to <clonePath>.run-state.json (sibling),
    // not <clonePath>/run-state.json (inside). The in-clone path made
    // the dir "non-empty" before RepoService.clone could run, blocking
    // every fresh start. Sibling-file is invisible to clone preflights;
    // findRecoverableRuns has been updated to scan the new location.
    this.statePath = `${clonePath}.run-state.json`;
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
      ...(snap.runConfig ? { runConfig: snap.runConfig } : {}),
    };
    try {
      // Atomic via tmp + rename. Atomic-rename keeps any concurrent
      // reader from seeing a half-written file.
      // 2026-05-04 fix: mkdir the PARENT of statePath (not clonePath
      // itself). With the sibling-file move above, the parent is the
      // user's parent dir + always exists once RepoService.clone has
      // created the clone subdir. Pre-clone writes will land beside
      // a still-missing clonePath, which is fine.
      mkdirSync(path.dirname(this.statePath), { recursive: true });
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

// T-Item-Recovery (2026-05-04): recovery-listing helpers. The full
// auto-resume flow is still deferred (it needs new runner methods +
// careful state-machine work to bring a runner up from a serialized
// transcript). This shipping slice covers the LISTING half: scan
// known parent dirs for run-state.json files, parse + validate,
// surface to the user via /api/swarm/recoverable-runs so they can
// see "you have N runs that didn't terminate cleanly" and decide
// what to do (today: manual investigation; future: auto-resume).

/** A recoverable run discovered on disk. */
export interface RecoverableRun {
  /** Full clone path that owns the run-state.json. */
  clonePath: string;
  /** Path to the run-state.json file itself. */
  stateFilePath: string;
  /** runId from the persisted state. */
  runId: string;
  /** Original preset (e.g. "blackboard"). */
  preset: string;
  /** Phase when last written — useful to distinguish "executing"
   *  (genuinely interrupted) vs "completed"/"stopped" (terminal,
   *  not really recoverable). */
  phase: string;
  /** Wall-clock when the run started. */
  startedAt: number;
  /** Wall-clock of the last persisted event. Approximate "how stale
   *  is this snapshot". */
  lastEventAt: number;
  /** Transcript entry count — gives the user a sense of how much
   *  work was done before the interruption. */
  transcriptLength: number;
  /** Number of pending amendments (user-injected directive nudges
   *  that haven't been folded in yet). */
  amendmentCount: number;
}

/** Scan one or more parent dirs for clone-dirs containing a
 *  run-state.json. Returns a list sorted by lastEventAt descending
 *  (most-recently-active first). Best-effort: any per-file parse or
 *  read error is silently skipped (the file might be corrupt or
 *  half-written; the user will notice in the response). */
export function findRecoverableRuns(
  parentPaths: readonly string[],
): RecoverableRun[] {
  const out: RecoverableRun[] = [];
  for (const parent of parentPaths) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    // 2026-05-04 fix: scan for sibling-file `<name>.run-state.json`
    // entries (new layout) AND fall back to in-clone `run-state.json`
    // for back-compat with snapshots written before the move. We
    // iterate directory entries and skip the sibling .run-state.json
    // files themselves (they're attached to a sibling dir of the
    // same basename).
    for (const name of entries) {
      // Skip the sibling state files when they appear as dir entries.
      if (name.endsWith(".run-state.json") || name.endsWith(".run-state.json.tmp")) continue;
      const cloneDir = path.join(parent, name);
      let isDir: boolean;
      try {
        isDir = statSync(cloneDir).isDirectory();
      } catch {
        continue;
      }
      const siblingStateFile = `${cloneDir}.run-state.json`;
      const inCloneStateFile = path.join(cloneDir, "run-state.json");
      const stateFile = existsSync(siblingStateFile)
        ? siblingStateFile
        : isDir && existsSync(inCloneStateFile)
          ? inCloneStateFile
          : null;
      if (!stateFile) continue;
      let raw: string;
      try {
        raw = readFileSync(stateFile, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.runId !== "string" ||
        typeof obj.preset !== "string" ||
        typeof obj.phase !== "string" ||
        typeof obj.startedAt !== "number" ||
        typeof obj.lastEventAt !== "number" ||
        !Array.isArray(obj.transcript) ||
        !Array.isArray(obj.amendments)
      ) {
        continue;
      }
      out.push({
        clonePath: cloneDir,
        stateFilePath: stateFile,
        runId: obj.runId,
        preset: obj.preset,
        phase: obj.phase,
        startedAt: obj.startedAt,
        lastEventAt: obj.lastEventAt,
        transcriptLength: obj.transcript.length,
        amendmentCount: obj.amendments.length,
      });
    }
  }
  // Most-recently-active first
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

/** Returns true when the persisted phase suggests the run was
 *  genuinely interrupted (vs cleanly terminal). Used by the UI to
 *  distinguish "you can probably resume this" from "this finished;
 *  the file just hasn't been cleaned up yet". */
export function isRecoverablePhase(phase: string): boolean {
  // Terminal phases: completed, stopped, failed → NOT recoverable.
  // Anything else (cloning/spawning/seeding/discussing/planning/
  // executing/paused/stopping/idle) is mid-flight + worth surfacing.
  return (
    phase !== "completed" && phase !== "stopped" && phase !== "failed"
  );
}

/** T-Item-Recover (2026-05-04): load + parse a snapshot from disk.
 *  Returns the full PersistedRunState (or null on parse error /
 *  missing file). The recover endpoint uses this to read the cfg +
 *  prior transcript before kicking a fresh run. */
export function loadSnapshot(stateFilePath: string): PersistedRunState | null {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.runId !== "string" ||
    typeof obj.preset !== "string" ||
    typeof obj.phase !== "string" ||
    typeof obj.startedAt !== "number" ||
    typeof obj.lastEventAt !== "number" ||
    !Array.isArray(obj.transcript) ||
    !Array.isArray(obj.amendments)
  ) {
    return null;
  }
  return obj as unknown as PersistedRunState;
}
