import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import { tokenTracker } from "./ollamaProxy.js";
import { RoundRobinRunner } from "../swarm/RoundRobinRunner.js";
import { BlackboardRunner } from "../swarm/blackboard/BlackboardRunner.js";
import { CouncilRunner } from "../swarm/CouncilRunner.js";
import { OrchestratorWorkerRunner } from "../swarm/OrchestratorWorkerRunner.js";
import { OrchestratorWorkerDeepRunner } from "../swarm/OrchestratorWorkerDeepRunner.js";
import { DebateJudgeRunner } from "../swarm/DebateJudgeRunner.js";
import { MapReduceRunner } from "../swarm/MapReduceRunner.js";
import { StigmergyRunner } from "../swarm/StigmergyRunner.js";
import { DEFAULT_ROLES, roleForAgent } from "../swarm/roles.js";
import { ConformanceMonitor } from "./ConformanceMonitor.js";
import { AmendmentsBuffer, type Amendment } from "./AmendmentsBuffer.js";

export interface OrchestratorOpts extends RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
}

// Re-exported so callers (routes/swarm.ts, index.ts) don't have to reach into
// the swarm/ namespace to pass a RunConfig.
export type { RunConfig };

// Persisted lastParentPath store. /tmp survives dev-server restarts
// but resets on reboot — fine for this use, since the user runs at
// least once after reboot and the path gets re-set automatically.
const LAST_PARENT_FILE = nodePath.join(tmpdir(), "ollama-swarm-last-parent.txt");
function readPersistedLastParent(): string | undefined {
  try {
    const v = readFileSync(LAST_PARENT_FILE, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}
function writePersistedLastParent(p: string): void {
  try {
    writeFileSync(LAST_PARENT_FILE, p, "utf8");
  } catch {
    // best-effort; the in-memory cache still works for this session
  }
}

// #238 + #240 (2026-04-28): persisted set of ALL parent paths the
// user has ever started a run from. Lets /api/swarm/runs and /api/
// swarm/memory aggregate across parents instead of being scoped to
// just the active clone's parent dir. Bounded to KNOWN_PARENTS_MAX
// entries (LRU on add) so the file doesn't grow unbounded.
const KNOWN_PARENTS_FILE = nodePath.join(tmpdir(), "ollama-swarm-known-parents.json");
const KNOWN_PARENTS_MAX = 32;
function readPersistedKnownParents(): string[] {
  try {
    const raw = readFileSync(KNOWN_PARENTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}
function writePersistedKnownParents(paths: string[]): void {
  try {
    writeFileSync(KNOWN_PARENTS_FILE, JSON.stringify(paths.slice(0, KNOWN_PARENTS_MAX)), "utf8");
  } catch {
    // best-effort
  }
}

// #293 (2026-04-28): when /tmp gets cleared (reboot, WSL session
// reset, manual rm) the persisted parents file disappears AND
// historical runs become invisible in the dropdown until the user
// happens to re-run from those parents. The 95-vs-9 bug surfaced
// during the 9-preset tour: only the CURRENT session's parent was
// in the list, hiding 86 prior summaries.
//
// Fix: at orchestrator construction, scan project-relative `runs/`
// + `runs_overnight*/` directories for any subfolder containing a
// `summary*.json`. Treat those as known parents — backfills the
// LRU list with everything we can see on disk regardless of /tmp
// state. Cheap (one-shot dir walk, no I/O on individual summary
// files), and idempotent — if /tmp already has the entries, the
// existing dedupe handles it.
/** #293: merge persisted (recent, ordered) + scanned (discovered)
 *  parent paths into a single LRU list. Persisted entries keep their
 *  order (most-recent first); scanned entries that aren't already in
 *  the list get appended. Capped at KNOWN_PARENTS_MAX. */
export function mergeKnownParents(persisted: string[], scanned: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of persisted) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  for (const p of scanned) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, KNOWN_PARENTS_MAX);
}

export function scanForRunParents(cwd: string): string[] {
  const found = new Set<string>();
  // dev.mjs launches the server with cwd=<root>/server, but the actual
  // runs/ + runs_overnight*/ dirs live at the project root, one level
  // up. Scan both bases so the discovery works regardless of where
  // the orchestrator is launched from.
  const bases = [cwd, nodePath.dirname(cwd)];
  // Match runs, runs_overnight, runs_overnight2 — any top-level dir
  // whose name suggests it holds run output.
  const isRunRoot = (name: string) =>
    name === "runs" || name.startsWith("runs_") || name.startsWith("runs-");
  for (const base of bases) {
    let topLevel: string[];
    try {
      topLevel = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of topLevel) {
      if (!isRunRoot(name)) continue;
      const root = nodePath.join(base, name);
      let stat;
      try {
        stat = statSync(root);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // Each clone-dir lives one level deep under the root.
      let clones: string[];
      try {
        clones = readdirSync(root);
      } catch {
        continue;
      }
      for (const clone of clones) {
        const cloneDir = nodePath.join(root, clone);
        try {
          if (!statSync(cloneDir).isDirectory()) continue;
        } catch {
          continue;
        }
        // Cheap probe: is there at least one summary*.json? Fast since
        // we don't read it — just check the dir for any matching entry.
        let hasSummary = false;
        try {
          for (const e of readdirSync(cloneDir)) {
            if (e === "summary.json" || (e.startsWith("summary-") && e.endsWith(".json"))) {
              hasSummary = true;
              break;
            }
          }
        } catch {
          continue;
        }
        if (hasSummary) found.add(root);
      }
    }
  }
  return [...found];
}

// Thin preset dispatcher. Holds one `SwarmRunner` per run and delegates the
// public surface to it. The state of a run lives on the runner itself.
export class Orchestrator {
  private runner: SwarmRunner | null = null;
  // Unit 62: stash the runId minted at run-start so the page-refresh
  // catch-up snapshot can include it. The runner doesn't own this
  // identifier (it's an orchestrator-level handle), so we merge it in
  // here rather than threading it through the runner contract.
  private runId?: string;
  // Pattern 9 fix (2026-04-24): same trick for runConfig + runStartedAt.
  // Discussion-preset runners (council/role-diff/etc.) don't include
  // runConfig in their status() — only blackboard does. Without it, the
  // web's AgentPanel role helper falls back to the blackboard-ish
  // "planner / worker" default for every other preset, both during the
  // run AND after completion when the WS run_started event has long
  // since fired. Stashing here is the single-call equivalent of teaching
  // 6 runners to populate runConfig — kept in sync with the run_started
  // payload below so the REST snapshot and the WS event don't drift.
  private runConfig?: SwarmStatusRunConfig;
  private runStartedAt?: number;
  // 2026-04-24: parent dir of the last successfully-started run.
  // Survives stop() / completion (unlike runConfig + runId) so the
  // /api/swarm/runs route can keep showing historical runs from the
  // same parent dir even when no run is currently active. Without
  // this, the runs dropdown was empty between runs (the route had
  // no way to know where to look). Cleared only when a new start()
  // overwrites it — never on stop or terminal phase.
  // Persisted to /tmp/ollama-swarm-last-parent.txt so a dev-server
  // restart doesn't reset the dropdown to empty. Survives restart;
  // reset only on full host reboot (acceptable — user runs once
  // post-reboot and it's set again).
  private lastParentPath?: string = readPersistedLastParent();
  // #238 + #240: every parent path the user has started a run from,
  // most-recent first. Lets the runs/memory routes aggregate across
  // parents (so the dropdown isn't empty when the user picks a fresh
  // parent dir, even though they have plenty of prior runs elsewhere).
  // #293: backfill from a project-relative scan so a /tmp wipe doesn't
  // invisibly truncate this list. Persisted entries take precedence
  // (LRU recency); scanned entries fill in the rest.
  private knownParentPaths: string[] = mergeKnownParents(
    readPersistedKnownParents(),
    scanForRunParents(process.cwd()),
  );
  // #299: per-run buffer of user-submitted directive amendments.
  // Opened on run start; runner reads via getAmendments(); closed on
  // run end (success OR failure).
  private readonly amendments = new AmendmentsBuffer();
  // #295: live conformance monitor. Class field (vs local var) so
  // its lifecycle survives runner.start()'s return — discussion
  // runners use `void this.loop(cfg)` so runner.start returns long
  // before the run actually ends.
  private conformanceMonitor?: ConformanceMonitor;

  constructor(private readonly opts: OrchestratorOpts) {
    // Persist the merged list back so the next read is consistent
    // even if the project gets moved or the cwd changes.
    if (this.knownParentPaths.length > 0) {
      writePersistedKnownParents(this.knownParentPaths);
    }
  }

  status(): SwarmStatus {
    if (this.runner) {
      const runnerStatus = this.runner.status();
      // Unit 62: stitch the orchestrator-level runId into the snapshot.
      // Leave runnerStatus.runId untouched if the runner already set one
      // (defensive — currently no runner does, but keeps the merge safe).
      // Pattern 9: same merge for runConfig + runStartedAt so the AgentPanel
      // role helper has cfg.preset to pick "drafter" / "mapper" / etc. even
      // for runs the runner itself doesn't surface runConfig for.
      return {
        ...runnerStatus,
        runId: runnerStatus.runId ?? this.runId,
        runConfig: runnerStatus.runConfig ?? this.runConfig,
        runStartedAt: runnerStatus.runStartedAt ?? this.runStartedAt,
      };
    }
    return {
      phase: "idle",
      round: 0,
      agents: this.opts.manager.toStates(),
      transcript: [],
    };
  }

  isRunning(): boolean {
    return this.runner?.isRunning() ?? false;
  }

  /** #299: append a user-submitted amendment to the active run.
   *  Returns the stored amendment, or null when there's no active
   *  run / the runId doesn't match / the text is empty. Emits a
   *  directive_amended SwarmEvent on success so all WS-connected
   *  tabs mirror the addition + the runner's next prompt picks it
   *  up via getAmendments(). */
  addAmendment(runId: string, text: string): Amendment | null {
    if (!this.runId || this.runId !== runId) return null;
    const stored = this.amendments.add(runId, text);
    if (stored) {
      this.opts.emit({
        type: "directive_amended",
        runId,
        ts: stored.ts,
        text: stored.text,
      });
    }
    return stored;
  }

  /** #299: read all amendments for a run, oldest first. Used by the
   *  runner to weave them into prompts. Defensive copy. */
  getAmendments(runId: string): Amendment[] {
    return this.amendments.list(runId);
  }

  // Returns the parent dir of the last successfully-started run.
  // Used by /api/swarm/runs to keep listing historical summaries
  // when no run is currently active.
  getLastParentPath(): string | undefined {
    return this.lastParentPath;
  }

  // #238 + #240: union of every parent dir the user has ever started
  // a run from this session (or in prior sessions, persisted). Used
  // by /api/swarm/runs?includeOtherParents=true and /api/swarm/memory
  // aggregation so the UI can show prior runs even when the active
  // parent is fresh. Most-recent first.
  getKnownParentPaths(): string[] {
    return [...this.knownParentPaths];
  }

  injectUser(text: string): void {
    this.runner?.injectUser(text);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    // Improvement #5 (post task #34): if a previous run is in a terminal
    // phase, isRunning() returns false but the runner reference is still
    // pinned (only stop() clears it — natural completion does not). Drop
    // it here so the new run gets a clean slot and the next status() call
    // doesn't surface stale state from the old runner. This is the
    // single-call equivalent of the explicit /stop the sequencer used to
    // need between every preset.
    if (this.runner) {
      try {
        await this.stop();
      } catch {
        // best-effort — if cleanup of the prior runner errors, surface it
        // via the next status() rather than blocking the new start.
      }
    }
    const runner = this.buildRunner(cfg.preset, cfg);
    // Assign up-front so status()/isRunning() reflect the in-progress run for
    // new WS clients and the POST /status endpoint while start() is still awaiting.
    this.runner = runner;
    // Task #125: tag every Ollama call made during this run with its
    // preset, so the usage dashboard can break down "blackboard ate
    // 60% of today's tokens" etc. Cleared in stop().
    tokenTracker.setCurrentPreset(cfg.preset);
    // Task #137: clear any prior run's quota-exhausted flag so this
    // run gets to probe the wall fresh. If the rate window has
    // reset / the user upgraded their plan / etc., the new run finds
    // out by trying. The flag re-trips immediately if not.
    tokenTracker.clearQuotaState();
    // Unit 52a + 52c + 52d: anchor for the UI's runtime ticker,
    // identity strip, and identifiers row. Single source of truth
    // across all 7 runners. Fires BEFORE runner.start so a slow clone
    // or spawn counts toward user-visible runtime. Carries:
    // - runId: Unit 52d — app-level handle, distinct from opencode
    //   session ids. Useful for cross-referencing logs and future
    //   persistent run history.
    // - resolved config so the UI renders without a REST round-trip.
    const runId = randomUUID();
    this.runId = runId;
    // Task #36: forward the minted runId into cfg so the runner can
    // include it in buildSummary → summary.json. Otherwise the runId
    // only lives in memory + the WS run_started event, never making
    // it to disk where the history dropdown reads digests from.
    cfg.runId = runId;
    // Task #42: resolve per-agent role names for role-diff so the UI
    // can render role labels in AgentPanel. Other presets leave this
    // undefined — runs with no role catalog get the generic worker
    // label. Uses the same catalog + wrap semantics as roleForAgent
    // in RoundRobinRunner so the UI matches what actually ran.
    let rolesForRunStarted: string[] | undefined;
    if (cfg.preset === "role-diff") {
      const catalog = cfg.roles && cfg.roles.length > 0 ? cfg.roles : DEFAULT_ROLES;
      rolesForRunStarted = [];
      for (let i = 1; i <= cfg.agentCount; i++) {
        rolesForRunStarted.push(roleForAgent(i, catalog).name);
      }
    }
    const startedAt = Date.now();
    // Pattern 9: build the runConfig snapshot once and reuse — same fields
    // go to the WS run_started event AND the REST status() snapshot.
    // Single source of truth so the two paths can't drift.
    const runConfig: SwarmStatusRunConfig = {
      preset: cfg.preset,
      // Per-agent overrides (Unit 42) fall back to cfg.model when absent.
      plannerModel: cfg.plannerModel ?? cfg.model,
      workerModel: cfg.workerModel ?? cfg.model,
      // Auditor model fallback chain matches BlackboardRunner: explicit
      // override → planner override → main model. Same surface as the
      // runner so the UI label is honest about what's actually running.
      auditorModel: cfg.auditorModel ?? cfg.plannerModel ?? cfg.model,
      dedicatedAuditor: cfg.dedicatedAuditor === true,
      roles: rolesForRunStarted,
      repoUrl: cfg.repoUrl,
      clonePath: cfg.localPath,
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      // Phase 4b of #243: include the resolved topology so the UI can
      // mirror exact agent specs (role chip + model override) without
      // re-deriving from preset+index. cfg.topology is always populated
      // by the route layer (synthesized from legacy fields when client
      // didn't post one).
      topology: cfg.topology,
    };
    this.runConfig = runConfig;
    this.runStartedAt = startedAt;
    // Cache parent dir so /api/swarm/runs can keep showing historical
    // runs in this folder even after this run terminates. Persisted
    // to /tmp so a dev-server restart doesn't lose it.
    this.lastParentPath = nodePath.dirname(nodePath.resolve(cfg.localPath));
    writePersistedLastParent(this.lastParentPath);
    // #238 + #240: append to known-parents list (LRU on duplicates).
    this.knownParentPaths = [
      this.lastParentPath,
      ...this.knownParentPaths.filter((p) => p !== this.lastParentPath),
    ].slice(0, 32);
    writePersistedKnownParents(this.knownParentPaths);
    this.opts.emit({
      type: "run_started",
      runId,
      startedAt,
      ...runConfig,
    });
    // #299: open the amendments buffer for this run. /api/swarm/amend
    // appends here; runners read via getAmendments(runId) on each turn.
    this.amendments.open(runId);
    // #295: spin up the conformance monitor when the run carries a
    // user directive. Polls Ollama every 90s with a "rate 0–100 how
    // on-topic is the recent transcript?" prompt. Skipped entirely
    // for runs without a directive (nothing to grade against) and
    // when CONFORMANCE_MONITOR=off in the env (escape hatch).
    const trimmedDirective = cfg.userDirective?.trim();
    if (
      trimmedDirective &&
      trimmedDirective.length > 0 &&
      process.env.CONFORMANCE_MONITOR !== "off" &&
      this.opts.ollamaBaseUrl
    ) {
      // #295 fix: monitor lives as a class field so its lifecycle is
      // decoupled from runner.start()'s return. Discussion runners
      // fire-and-forget their loop (`void this.loop(cfg)`) so
      // runner.start resolves in seconds even when the run will
      // continue for minutes — putting monitor.stop() in finally{}
      // killed the timer before any tick fired. Now: bind isActive
      // so the monitor self-stops when the run actually ends.
      this.conformanceMonitor?.stop(); // defensive: clear any stale
      this.conformanceMonitor = new ConformanceMonitor({
        runId,
        directive: trimmedDirective,
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        graderModel: cfg.model,
        getTranscript: () => this.runner?.status().transcript ?? [],
        emit: this.opts.emit,
        isActive: () => this.runner !== null && (this.runner?.isRunning() ?? false),
      });
      this.conformanceMonitor.start();
    }
    try {
      await runner.start(cfg);
    } catch (err) {
      // Runner's start threw partway through (e.g. clone failed, spawn timed out).
      // Clean up anything it managed to create and drop the reference — otherwise
      // the dispatcher stays pinned to a stuck runner and the next start call
      // false-positives as "already running".
      try {
        await runner.stop();
      } catch {
        // ignore cleanup errors; the original failure is what we want to surface
      }
      if (this.runner === runner) {
        this.runner = null;
        // Unit 62: keep runId paired with runner — drop it on failed start.
        this.runId = undefined;
        this.runConfig = undefined;
        this.runStartedAt = undefined;
      }
      throw err;
    } finally {
      // #295 fix: do NOT stop the conformance monitor here. Discussion
      // runners' `runner.start()` returns before the actual run ends
      // (fire-and-forget loop), so this finally{} fires too early.
      // The monitor's own isActive() check (bound to runner.isRunning)
      // self-stops it when the run truly ends. orchestrator.stop()
      // also calls conformanceMonitor.stop() as a backstop.
      // #299: close the amendments buffer for this run. Safe here
      // because amendments are only consumed at planner-tier prompts;
      // by the time we get here the START phase is done.
      this.amendments.close(runId);
    }
  }

  // Task #167: soft-stop entry point. If the active runner supports
  // drain() (blackboard does), use it; otherwise fall through to hard
  // stop. The runner manages its own escalation deadline + watcher.
  async drain(): Promise<void> {
    if (!this.runner) return;
    if (typeof this.runner.drain === "function") {
      await this.runner.drain();
      return;
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    if (!this.runner) return;
    const runner = this.runner;
    try {
      await runner.stop();
    } finally {
      // #295 fix: backstop for the conformance monitor — covers the
      // explicit /api/swarm/stop path. Natural-completion path
      // self-stops via isActive() in the poll loop.
      this.conformanceMonitor?.stop();
      this.conformanceMonitor = undefined;
      // Task #125: clear preset tag — calls between runs (e.g. an
      // exploratory direct curl to the proxy) bucket as "(idle)".
      tokenTracker.setCurrentPreset(undefined);
      // Once a run is fully stopped, drop the reference so the next start gets
      // a fresh slate rather than inheriting the previous runner's terminal phase.
      this.runner = null;
      // Unit 62: clear the runId too so a status() after stop reports an
      // idle slate instead of a stale handle from the previous run.
      this.runId = undefined;
      this.runConfig = undefined;
      this.runStartedAt = undefined;
    }
  }

  private buildRunner(preset: PresetId, cfg: RunConfig): SwarmRunner {
    // #299: thread getAmendments into runner opts so each runner can
    // read live HITL nudges via this.opts.getAmendments(). The
    // amendments buffer lives on the orchestrator; we bind it here
    // (pre-bound to the active runId) so the runner doesn't need a
    // direct reference to AmendmentsBuffer or the runId. Returns []
    // safely when called before runId is minted (start-time race).
    const opts = {
      ...this.opts,
      getAmendments: () =>
        this.runId ? this.amendments.list(this.runId) : [],
    };
    switch (preset) {
      case "round-robin":
        return new RoundRobinRunner(opts);
      case "role-diff": {
        // Unit 32: optional user-supplied roles take precedence over the
        // default catalog. The route validates shape (name + guidance,
        // bounded counts) so we just need to pick which list to pass.
        // An empty `roles` array is treated as "user wants defaults",
        // same as omitting the field entirely — saves callers a UI bug
        // where clearing all roles would otherwise crash the runner
        // (roleForAgent throws on an empty array).
        const roles =
          cfg.roles && cfg.roles.length > 0 ? cfg.roles : DEFAULT_ROLES;
        return new RoundRobinRunner(opts, { roles });
      }
      case "blackboard":
        return new BlackboardRunner(opts);
      case "council":
        // Parallel drafts + reconcile. Round 1 hides peer drafts from each
        // agent's prompt; Round 2+ reveals them. Discussion-only.
        return new CouncilRunner(opts);
      case "orchestrator-worker":
        // Agent 1 = lead (plans + synthesizes), 2..N = workers (parallel,
        // isolated subtasks). `rounds` = plan→execute→synthesize cycles.
        return new OrchestratorWorkerRunner(opts);
      case "orchestrator-worker-deep":
        // Task #131: 3-tier OW. Agent 1 = orchestrator, agents 2..K+1 =
        // mid-leads (K = max(1, ceil((N-1)/6))), agents K+2..N = workers
        // partitioned across mid-leads. Per cycle: top-plan → mid-plan →
        // workers → mid-synth → top-synth. Scales coverage past ~8
        // workers without inflating any single tier's prompt context.
        return new OrchestratorWorkerDeepRunner(opts);
      case "debate-judge":
        // Fixed 3 agents: Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.
        // Per round Pro+Con exchange; Judge scores on the final round.
        return new DebateJudgeRunner(opts);
      case "map-reduce":
        // Agent 1 = reducer, 2..N = mappers. Mappers each get a round-robin
        // slice of top-level repo entries and inspect them in isolation;
        // reducer synthesizes all mapper reports per cycle.
        return new MapReduceRunner(opts);
      case "stigmergy":
        // Self-organizing repo exploration. No planner, no roles — agents
        // pick their own next file based on a shared annotation table
        // (pheromone trail) that the runner maintains in memory.
        return new StigmergyRunner(opts);
      default: {
        // Exhaustiveness check — if a new preset is added to PresetId, TS errors here.
        const _exhaustive: never = preset;
        throw new Error(`unknown preset: ${String(_exhaustive)}`);
      }
    }
  }
}
