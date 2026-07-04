# PROJECT-REVIEW.md — ollama_swarm Full Code Review

**Review date:** 2026-07-03  
**Scope:** Entire project (Node/React/TS, server + web + shared). Focus on runtime paths: Orchestrator, BlackboardRunner + substrate (TodoQueue, WorkerPipeline, caps, v2Adapters), ToolDispatcher, providers (pickProvider + 5 impls + ProviderGateway), state machine, Brain-as-OS (brainOverseer/*), UI Zustand per-run isolation, security (clone/paths/exec), concurrency, error handling, reliability.  
**Process:** list_dir on ., server/, server/src/, web/src/, shared/src/, docs/, blackboard/, brainOverseer/. Read critical files (README, STATUS.md, known-limitations.md, active-work.md, index.ts, config.ts, Orchestrator.ts, BlackboardRunner.ts key sections, ToolDispatcher.ts, v2Adapters.ts, App.tsx, package.jsons, providers/, routes/swarm.ts, shared/runStateMachine.ts, RepoService, resolveSafe, buildCommandAllowlist, caps, capManager, WorkerPipeline, AgentManager, broadcast, CostTracker, ConformanceMonitor, brain* files, SwarmStoreProvider, etc.). Extensive grep for TODOs, any/abuse, exec/bash/spawn, locks/race/concurrent/CAS, error paths (try/catch/unhandled), providers, state machines, paths/fs.

## Summary

A sophisticated, actively-developed system for concurrent multi-agent LLM swarms (primarily local Ollama) targeting GitHub repos, with 12 presets (blackboard primary for writes), a Brain-as-OS layer for monitoring/proposals/self-upgrades/provisioning, direct provider calls (post-E3 removal of opencode subprocesses), in-process ToolDispatcher, hunk-based editing + CAS via git, per-run isolation, and rich observability (conformance, drift, caps). Architecture is sound in core substrate (state machine + TodoQueue + WorkerPipeline) and multi-tenancy, with strong reliability primitives. Security layers (resolveSafe symlink defense, allowlist, clonePathGuard, preflights) are present but have platform gaps and incomplete enforcement. Code quality is high in tested paths but shows duplication in error handling, casts, and legacy flag soup alongside V2 state machine. Test coverage is extensive (hundreds of .test.ts) but uneven on security edges, Windows, and Brain self-upgrade. Docs are mostly accurate but lag some V2/Brain details. Overall verdict: production-usable for the blackboard preset on Linux/macOS with caveats; needs hardening for full cross-platform reliability, tighter Brain gating, and cleanup of legacy coordination.

## Strengths

- **Architecture soundness**: Blackboard substrate (TodoQueue, WorkerPipeline, RunStateObserver, v2Adapters) cleanly separates prompting from apply/CAS/commit/verify. Shared `runStateMachine.ts` provides pure reducer for phases. Brain-as-OS (brainOverseer/* + provisioner + selfUpgrader + queue) layered above Orchestrator without tight coupling. Per-run `ActiveRun` + `createAgentManager(runId)` + `SwarmStoreProvider` achieves strong isolation for concurrency.
- **Concurrency & reliability**: Hard caps (wall/clock/commits/todos) with 5s-tick watchdog (`capManager.ts`, `BlackboardRunnerConstants`), cost cap in CostTracker + preflight projector, conformance/embedding-drift monitors, sseAwareTurnWatchdog, provider failover/resilience/*, preflightDiskCheck + cost + verify gates, auto-rollback, tier ratchet with retry. `ProviderGateway` adds rate limits/circuits/fair scheduling.
- **Security & sandboxing efforts**: `resolveSafe.ts` (lexical + realpath + symlink + .git + depth-cap), `buildCommandAllowlist.ts` (binary + metachar block), `clonePathGuard.ts` (tracked + known parents), `ToolDispatcher` profiles (swarm vs swarm-read vs builder), `realVerifyAdapter` + detached spawn with group kill (attempt), `assertAllowedClonePath`. No arbitrary write from workers (JSON hunks only). GITHUB_TOKEN and keys server-side only.
- **Provider abstraction**: Post-E3 clean `SessionProvider` + `pickProvider` (singletons + prefix detect), 5 providers (Ollama/OllamaCloud/Anthropic/OpenAI/OpenCode), `chatOnce` + `promptWithRetry`. Gateway integration opt-in.
- **Observability/UI**: Per-run Zustand (store + applyEvent + SwarmStoreProvider + useRunScopedWebSocket), transcript summarization pipeline (strip + summarizeAgentJson), Board wire compat, ActiveRunsPanel, Brain panels, V2 event log, cost breakdown, history via parent scan + persister. Live streaming + reconnection.
- **Code quality & testing**: Heavy investment in unit tests (WorkerPipeline, caps, applyHunks, TodoQueue wrappers, providers, resilience, runStateMachine, etc.). Extracted pure modules (runnerHelpers, contextBuilders, etc.). Many edge cases explicitly tested (CAS, replan, verify fail, memory pressure).
- **Docs**: STATUS.md + active-work.md + known-limitations.md + ARCHITECTURE.md (blackboard) + INITIALIZATION-SEQUENCE are excellent "single source of truth" maps. README accurately describes current E3 state.

## Issues

### Issue 1 -- Severity: bug
- File: server/src/swarm/blackboard/v2Adapters.ts:92
- Description: `realVerifyAdapter` uses `process.kill(-cp.pid!, "SIGTERM")` (and SIGKILL) for process group. Negative PIDs are POSIX-only; on Windows (user OS + common WSL boundary) this throws or does nothing, leaving verify processes (npm test etc.) orphaned on timeout. Spawn uses `detached: true` + shell but kill path is Unix-specific. Matches `treeKill.ts` which has cross-platform intent but verify bypasses it.
- Suggestion: Use `treeKill` (already in services) or platform-conditional kill (e.g. taskkill on win32 for whole tree). Add Windows tests or guard. Document the platform assumption.
- Status: open

### Issue 2 -- Severity: bug
- File: server/src/swarm/blackboard/WorkerPipeline.ts:155
- Description: Delete handling for `newText === ""` is broken/incomplete: writes empty string via fs adapter (comment admits "we need to delete"), counts removed lines, but relies on git later. Combined with `realFilesystemAdapter.write` (which does `fs.unlink` only for empty), this can leave empty files or race on concurrent workers. `applyHunks` + git commit may not clean deletes correctly in all cases (no explicit `git rm`).
- Suggestion: Make delete explicit in FS adapter (separate op or special value). Update git adapter to `git rm --cached` or handle in commit. Add tests for delete hunks + CAS on delete.
- Status: open

### Issue 3 -- Severity: bug
- File: server/src/services/Orchestrator.ts:714 (start), 560 (stopRun), 989 (stopAll), and cleanup paths
- Description: Complex try/finally + startInProgress gate + amendments + persister + cloneLock + monitors. Error path at 932-958 deletes run but some resources (e.g., brain queue interaction, tokenTracker per-run) may leak if stop() races or partial init fails. `cleanupStaleRuns` + listActiveRuns filter `isRunning()` but `runs.size` used for cap before full cleanup. Per-run quota in proxy not always attributed on early failures.
- Suggestion: Introduce explicit `ActiveRun` resource RAII or a `closeRun(run)` helper that centralizes releaseLock/persister.stop/monitors/amendments close. Make start() idempotent under concurrent calls more robustly. Audit tokenTracker attribution on error paths.
- Status: open

### Issue 4 -- Severity: bug
- File: server/src/swarm/blackboard/resolveSafe.ts:30 (and callers in ToolDispatcher, v2Adapters, WorkerPipeline)
- Description: Symlink defense + realpath walk is strong, but `fs.realpath` + lstat loop + 1000-depth cap still has TOCTOU window under concurrent modification by other workers (or external). No atomicity with the CAS commit in git. Windows symlink/junction/UNC handling can differ from POSIX realpath assumptions (path.resolve + sep checks).
- Suggestion: After resolve, re-validate hash in a critical section or rely more on git for conflict (already does). Add explicit Windows path normalization tests. Consider adding fs.watch or inode checks for high-stakes writes.
- Status: open

### Issue 5 -- Severity: suggestion
- File: server/src/routes/swarm.ts:174 (and ~1178)
- Description: `(t as any).staleReason`, `(t as any).commitTier`, `(tokenTracker as any).pressure` casts bypass types. Similar `as any` in tests and a few runtime spots (routes/dev.ts, providers/AnthropicProvider.ts).
- Suggestion: Add proper discriminated types or narrow interfaces for board todos and tokenTracker (export pressure type). Replace casts with type guards or optional chaining + defined fields.
- Status: open

### Issue 6 -- Severity: suggestion
- File: server/src/tools/ToolDispatcher.ts:230 (bashTool), 40 (defaultToolsForProfile), PROFILES, and buildCommandAllowlist.ts:80
- Description: "swarm-builder" profile advertises bash + allowlist exists, but main blackboard workers use "swarm" (no tools); planner/auditor use "swarm-read". Bash is exposed in some discussion presets or via writeMode. Metachar block + binary allowlist is good defense-in-depth but `execAsync` (no shell:false) + cwd only still permits some argument injection or long-running cmds that exceed timeout. No rate limit on bash calls per agent.
- Suggestion: Make bash opt-in explicit per preset + add execution budget (count + total time). Audit which presets actually enable "swarm-builder". Consider `shell: false` + arg split for stricter parsing. Add integration tests that attempt forbidden cmds.
- Status: open

### Issue 7 -- Severity: suggestion
- File: server/src/index.ts:471 (unhandledRejection), 478 (uncaught), Orchestrator + runners error paths
- Description: Global handlers broadcast + log but do not always correlate to a specific runId or terminate the exact run cleanly. Many places swallow errors with `catch { /* ignore */ }` or console.warn (e.g., releaseLock, proxy stop, broadcaster). Error taxonomy exists (`errorTaxonomy.ts`) but not uniformly used in top-level dispatch.
- Suggestion: Centralize error reporting with runId tagging. Use Conformance/Brain exceptionCollector patterns more broadly. Ensure unhandled paths always attempt `runner.stop(runId)` + cleanup.
- Status: open

### Issue 8 -- Severity: suggestion
- File: server/src/swarm/blackboard/caps.ts:10 (exported WALL_CLOCK_CAP_MS etc. from config at import time), capManager.ts, BlackboardRunner.ts
- Description: Caps are re-evaluated from env at module load; per-run overrides via RunConfig win in some paths but the exported constants are used directly elsewhere. Watchdog is 5s-tick (good) but interacts with pause/resume/memory/subscriber in complex state in capManager. State machine (shared) has pausedReason but legacy flags still live in runner.
- Suggestion: Make cap values strictly per-run (no module exports of computed consts). Unify on the V2 RunState + RunStateObserver for cap decisions. Add explicit tests for cap + drain + concurrent interaction.
- Status: open

### Issue 9 -- Severity: suggestion
- File: server/src/swarm/blackboard/brainOverseer/selfUpgrader.ts:10 (uses execFileSync), brainQueue.ts, provisioner.ts, brainService.ts
- Description: Self-upgrade and Brain provisioning run git/exec synchronously in places and gate only on `getActiveRunCount() === 0`. No dry-run preview enforcement in core (UI has preview), no rollback beyond git, no lock around patch apply vs new Brain-initiated runs. Patch application can race with provisioner starting a run.
- Suggestion: Use async git + execFile. Add stronger transactional gate (brainQueue + explicit "no runs + no startInProgress"). Record applied commits for easy revert. Surface approval step for non-dev use.
- Status: open

### Issue 10 -- Severity: suggestion
- File: server/src/services/Orchestrator.ts:480 (listActiveRuns casts), routes/swarm.ts (start body construction), web/src/App.tsx:139 (per-run wrapper)
- Description: `as any` in listActiveRuns for brain fields. Start path builds huge RunConfig inline with many optionals. Per-run store in App is good but legacy "/" + HomeRoute still mixes singleton logic; review/replay modes add complex conditionals and polling.
- Suggestion: Type the ActiveRun list properly. Extract RunConfig builder. Simplify App routing/hydration with clearer mode flags.
- Status: open

### Issue 11 -- Severity: nit
- File: server/src/config.ts:150 (SWARM_MAX_CONCURRENT_RUNS etc. transforms), multiple places reading config at import
- Description: Heavy use of zod .transform for numbers/enums at load; some defaults are strings then coerced. Mutable module-level config after parse. Several envs still carry historical opencode baggage (OPENCODE_SERVER_PASSWORD always required at load).
- Suggestion: Keep transforms but document. Freeze the final config object. Drop dead envs or mark clearly as legacy-only.
- Status: open

### Issue 12 -- Severity: nit
- File: shared/src/runStateMachine.ts (exists + pure), server/src/swarm/blackboard/BlackboardRunner.ts + lifecycleState.ts + RunStateObserver
- Description: V2 state machine is implemented and documented as "primary", but BlackboardRunner still carries large legacy flag-based coordination (boardCounts, replan, etc.) alongside. Wire compat + observer exist for migration. Docs note the dual tracking.
- Suggestion: Accelerate full cutover or explicitly mark legacy paths as deprecated in code. Add a conformance test asserting V2 state matches legacy flags on every transition.
- Status: open

### Issue 13 -- Severity: nit
- File: server/src/providers/pickProvider.ts (singletons), ProviderGateway.ts, multiple provider impls
- Description: Provider singletons + __test overrides are convenient but introduce global mutable state. Gateway queues are per-provider but cross-run scheduling interacts with per-run attribution.
- Suggestion: Consider per-run or context-scoped providers for stronger isolation in future. Add metrics on queue drops.
- Status: open

### Issue 14 -- Severity: suggestion
- File: server/src/routes/swarm.ts:806 (open spawn for file manager), 1421 (explorer/cmd/open/xdg), index.ts + middleware
- Description: `spawn` for "open in explorer" is best-effort and platform-branched; errors swallowed. No allowlist or path validation beyond resolve in some branches. Minor surface.
- Suggestion: Reuse safe path helpers. Add rate limit or user-intent guard.
- Status: open

### Issue 15 -- Severity: nit
- File: Many places (e.g. BlackboardRunner ~2500+ LOC, contextBuilders, extracted runners)
- Description: Significant extraction has occurred (good), but some modules still long. Duplication in error formatting, summary writing, and prompt helpers across presets.
- Suggestion: Continue extraction (errorTaxonomy already helps). Consider a small "runner core" facade. Measure bundle/test time.
- Status: open

## Additional Observations

- **Test coverage**: Very good on core (applyHunks, caps, pipelines, providers, resilience, state machine, TodoQueue). Gaps visible on: full end-to-end Brain self-upgrade + provision under load, Windows-specific kill/paths, ToolDispatcher bash under all profiles, concurrent cap + brain interactions, clonePathGuard under rename races.
- **Docs vs reality**: STATUS.md and known-limitations.md track reality closely (E3, multi-tenant, V2). Some Brain "DONE" items in active-work.md are implemented but gated (self-upgrade safety). ARCHITECTURE.md (blackboard) is authoritative.
- **Edge cases**: Host sleep handled in caps tick; quota pause/resume; memory pressure; reconnect; review mode hydration; zero-criteria contracts. Most are covered.
- **Performance**: Gateway bounded queues, proxy pressure, bounded streaming. No obvious leaks in main paths.
- **Windows/WSL notes**: README + AGENT-GUIDE call out hazards; code has normalizeWslPath but POSIX kill + path.sep assumptions remain risks (see Issue 1).

## Verdict

**Strong foundation with production blackboard + Brain surface.** Core correctness and isolation are solid; reliability features are mature. Primary risks are platform (Windows kill/paths), incomplete legacy/V2 unification, Brain self-modification safety, and scattered error/cast hygiene. Recommend prioritizing the verify kill + delete pipeline + centralized run cleanup before expanding autonomous Brain loops. The project demonstrates disciplined large-scale refactor (E3, multi-tenant, V2 substrate) while shipping features.

**File written to:** ./PROJECT-REVIEW.md

(Concise user summary follows in chat.)
