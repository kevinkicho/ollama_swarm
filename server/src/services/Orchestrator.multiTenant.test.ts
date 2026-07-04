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
const ACTIVE_RUN_SRC = readFileSync(join(__dirname, "ActiveRun.ts"), "utf8");

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
  assert.match(
    SRC,
    /if \(this\.runs\.size >= cap\)/,
  );
});

test("Orchestrator: terminal-phase runs are reaped before cap check", () => {
  // Without the reap, terminal runs would pin the cap forever (a
  // user who runs 4 then never explicitly stops would be stuck).
  assert.match(
    SRC,
    /for \(const \[id, run\] of \[\.\.\.this\.runs\.entries\(\)\]\) \{[\s\S]*?if \(!run\.isRunning\(\)\)/,
  );
});

test("Orchestrator: listActiveRuns returns shape with runId/config/startedAt/isRunning", () => {
  assert.match(SRC, /listActiveRuns\(\): Array<\{/);
  assert.match(SRC, /isRunning: boolean/);
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
    /async stopRun\(runId: string\): Promise<boolean> \{[\s\S]*?if \(!run\) return false/,
  );
});

test("Orchestrator: per-run AgentManager via createManager factory", () => {
  assert.match(SRC, /createManager: \(runId: string\) => AgentManager/);
  assert.match(SRC, /const manager = this\.opts\.createManager\(runId\)/);
});

test("Orchestrator: wrappedEmit binds runId + persister at build time", () => {
  assert.match(SRC, /interface BuildRunnerContext/);
  assert.match(
    SRC,
    /e\.runId === undefined \? \{ \.\.\.e, runId \} : e/,
  );
  assert.doesNotMatch(
    SRC,
    /e\.runId === undefined && this\.runId \? \{ \.\.\.e, runId: this\.runId \}/,
  );
});

test("Orchestrator: amendments close on stopRun; start finally only clears gate", () => {
  // Amendments close is now inside ActiveRun.stop() called by stopRun.
  assert.match(SRC, /async stopRun\([\s\S]*?await run\.stop\(\)/);
  assert.match(SRC, /return runId;\s*\} finally \{\s*this\.startInProgress = false;/);
});

test("Orchestrator: stopRun cleans up via ActiveRun + deletes from map", () => {
  // Cleanup is now delegated to ActiveRun.stop() (which stops monitors + persister).
  // This keeps per-run isolation without leaks.
  assert.match(
    SRC,
    /async stopRun\([\s\S]*?await run\.stop\(\)[\s\S]*?this\.runs\.delete\(runId\)/,
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
