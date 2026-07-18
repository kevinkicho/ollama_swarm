// T-Item-MultiTenant Phase 3-5 (2026-05-04): tests for the multi-
// tenant orchestrator methods. The full lifecycle (start/stop/status
// through real runners) needs an AgentManager + RepoService chain
// which is heavy for a unit test, so these tests exercise the
// per-runId methods + the cap logic via the public surface with
// minimal fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "Orchestrator.ts"), "utf8");
const EMIT_SRC = readFileSync(join(__dirname, "orchestratorEmit.ts"), "utf8");
const BUILD_RUNNER_SRC = readFileSync(join(__dirname, "orchestratorBuildRunner.ts"), "utf8");
const ACTIVE_RUN_SRC = readFileSync(join(__dirname, "ActiveRun.ts"), "utf8");
const ALL_ORCH_SRC = [SRC, EMIT_SRC, BUILD_RUNNER_SRC].join("\n");

test("Orchestrator: ActiveRun class declared with required fields", () => {
  // Structural: keeps refactor honest if a future edit drops a field.
  // Note: now a class in ActiveRun.ts (was interface in Orchestrator).
  assert.match(ACTIVE_RUN_SRC, /export class ActiveRun/);
  assert.match(ACTIVE_RUN_SRC, /runner: SwarmRunner/);
  assert.match(ACTIVE_RUN_SRC, /manager: AgentManager/);
  assert.match(ACTIVE_RUN_SRC, /runId: string/);
  assert.match(ACTIVE_RUN_SRC, /runConfig: SwarmStatusRunConfig/);
  assert.match(ACTIVE_RUN_SRC, /startedAt: number/);
  assert.match(ACTIVE_RUN_SRC, /persister: RunStatePersister/);
});

test("ActiveRun: unified teardown closes amendments + lock; dispose never re-stops runner", () => {
  assert.match(ACTIVE_RUN_SRC, /async teardown\(opts: ActiveRunTeardownOpts/);
  assert.match(ACTIVE_RUN_SRC, /releaseResources\(\)/);
  // dispose must close amendments (was a leak before).
  assert.match(
    ACTIVE_RUN_SRC,
    /dispose\(\): void \{[\s\S]*?amendments\.close/,
  );
  // stopRunner:false path must exist for natural completion.
  assert.match(ACTIVE_RUN_SRC, /stopRunner !== false/);
  // Debug WriteStream must end on release (FD leak fix).
  assert.match(ACTIVE_RUN_SRC, /this\.hub\.close\(\)/);
});

test("Orchestrator: runs map replaces the singleton runner field", () => {
  // The old `private runner: SwarmRunner | null = null;` line should
  // be gone — replaced by the runs map. The compat getter still
  // reads `this.runner` everywhere, but that should resolve via
  // activeRun, not a direct field.
  assert.match(SRC, /private runs = new Map<string, ActiveRun>\(\)/);
  // Compat getter for legacy single-arg paths
  assert.match(SRC, /private get runner\(\): SwarmRunner \| null/);
  assert.match(SRC, /private get activeRun\(\): ActiveRun \| null/);
});

test("Orchestrator: cap check uses opts.maxConcurrentRuns with default 4", () => {
  assert.match(
    SRC,
    /const cap = this\.opts\.maxConcurrentRuns \?\? 4/,
  );
  // Cap must count live runners, not terminal ghosts still in the map.
  assert.match(
    SRC,
    /const live = this\.countLiveRuns\(\);\s*if \(live >= cap\)/,
  );
});

test("Orchestrator: terminal-phase runs are reaped before cap check", () => {
  // Without the reap, terminal runs would pin the cap forever (a
  // user who runs 4 then never explicitly stops would be stuck).
  // Reap uses teardown(stopRunner:false) so completed summaries stay intact.
  assert.match(
    SRC,
    /cleanupStaleRuns[\s\S]*?phase === "stopped"[\s\S]*?teardown\(\{\s*stopRunner:\s*false/,
  );
});

test("Orchestrator: stopRun/drainRun use exact runId only (no prefix match)", () => {
  assert.doesNotMatch(
    SRC,
    /k\.startsWith\(runId\) \|\| runId\.startsWith\(k\)/,
    "prefix match is unsafe under multi-tenant concurrency",
  );
  assert.match(SRC, /getRunExact\(runId\)/);
});

test("Orchestrator: drainRun reports soft vs hard-fallback mode", () => {
  assert.match(
    SRC,
    /mode:\s*"soft"\s*\|\s*"hard-fallback"\s*\|\s*"already-stopped"/,
    "drainRun must return explicit mode for UI honesty",
  );
  assert.match(SRC, /mode:\s*"hard-fallback"/);
  assert.match(SRC, /mode:\s*"soft"/);
});

test("Orchestrator: natural completion reaps run without re-stop", () => {
  // start() awaits the full loop; waitUntilSettled + isRunning are backstops.
  assert.match(
    SRC,
    /waitUntilSettled/,
    "must join runner settle before natural-complete reap",
  );
  assert.match(
    SRC,
    /while \(this\.runs\.has\(runId!\) && activeRun\.isRunning\(\)\)/,
    "poll isRunning as backstop before reap",
  );
  assert.match(
    SRC,
    /!activeRun\.isTornDown\(\) && !activeRun\.isRunning\(\)/,
    "only reap when runner is truly terminal",
  );
  assert.match(
    SRC,
    /removeRun\(activeRun, \{\s*stopRunner:\s*false\s*\}\)/,
    "free map+lock without runner.stop on natural complete",
  );
  assert.match(
    SRC,
    /orphanCloneLock/,
    "must track clone lock until ActiveRun owns it",
  );
});

test("Orchestrator: listActiveRuns returns shape with runId/config/startedAt/isRunning", () => {
  assert.match(SRC, /listActiveRuns\(\): Array<\{/);
  assert.match(SRC, /isRunning: boolean/);
  assert.match(SRC, /phase\?: string/);
  assert.match(SRC, /drainEligible\?: boolean/);
});

test("Orchestrator: statusForRun falls back to persister for unknown runId", () => {
  assert.match(
    SRC,
    /statusForRun\(runId: string\): SwarmStatus \| null \{[\s\S]*?const run = this\.runs\.get\(runId\)/,
  );
});

test("Orchestrator: injectUserForRun + stopRun both 404 (return false) on unknown runId", () => {
  assert.match(
    SRC,
    /injectUserForRun\([\s\S]*?const run = this\.runs\.get\(runId\);\s*if \(!run\) return false/,
  );
  assert.match(
    SRC,
    /async stopRun\(runId: string\): Promise<boolean> \{[\s\S]*?if \(!run\) \{[\s\S]*?return false/,
  );
});

test("Orchestrator: per-run hub + AgentManager share one RunEventHub", () => {
  assert.match(SRC, /createHub: \(runId: string\) => RunEventHub/);
  assert.match(SRC, /createManager: \(runId: string, hub: RunEventHub\) => AgentManager/);
  assert.match(SRC, /const runHub = this\.opts\.createHub\(runId\)/);
  assert.match(SRC, /const manager = this\.opts\.createManager\(runId, runHub\)/);
});

test("Orchestrator: wrappedEmit binds runId + persister at build time", () => {
  // BuildRunnerContext lives in orchestratorBuildRunner after extract.
  assert.match(ALL_ORCH_SRC, /interface BuildRunnerContext|export interface BuildRunnerContext/);
  // Stamp lives in orchestratorEmit.ts after extract; still must not use this.runId.
  assert.match(
    ALL_ORCH_SRC,
    /e\.runId === undefined \? \{ \.\.\.e, runId \} : e/,
  );
  assert.doesNotMatch(
    ALL_ORCH_SRC,
    /e\.runId === undefined && this\.runId \? \{ \.\.\.e, runId: this\.runId \}/,
  );
  assert.match(
    ALL_ORCH_SRC,
    /createWrappedEmitExtracted|createWrappedEmit\(/,
  );
});

test("Orchestrator: amendments close on stopRun; start finally only clears gate", () => {
  // Amendments close lives in ActiveRun.releaseResources via removeRun → teardown.
  assert.match(SRC, /async stopRun\([\s\S]*?await this\.removeRun\(/);
  assert.match(ACTIVE_RUN_SRC, /amendments\.close\(this\.runId\)/);
  assert.match(SRC, /return runId;\s*\} catch[\s\S]*?finally \{\s*this\.startInProgress = false;/);
});

test("Orchestrator: stopRun cleans up via removeRun + deletes from map", () => {
  // Unified path: stopRun → removeRun → teardown + runs.delete.
  assert.match(SRC, /async stopRun\([\s\S]*?await this\.removeRun\(/);
  assert.match(
    SRC,
    /private async removeRun\([\s\S]*?await run\.teardown\([\s\S]*?this\.runs\.delete\(run\.runId\)/,
  );
});

test("config: SWARM_MAX_CONCURRENT_RUNS field present with default 4 + bounded [1, 16]", () => {
  const configSrc = readFileSync(
    join(__dirname, "..", "config.ts"),
    "utf8",
  );
  assert.match(configSrc, /SWARM_MAX_CONCURRENT_RUNS:/);
  assert.match(configSrc, /\.default\("4"\)/);
  // Bounded check
  assert.match(configSrc, /n >= 1 && n <= 16/);
});
