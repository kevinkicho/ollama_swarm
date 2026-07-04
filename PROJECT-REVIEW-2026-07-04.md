# PROJECT-REVIEW-2026-07-04.md — ollama_swarm Full Code Review

**Review date:** 2026-07-04  
**Scope:** Entire project (full codebase review). Server (TS/Node), web (React/TS), shared. Focus areas: deltas since 2026-07-03 review; correctness > style; concurrency/ActiveRun paths; blackboard substrate (TodoQueue, WorkerPipeline, apply/delete/CAS, v2Adapters); Brain layer (brainOverseer/*); providers (pickProvider, ProviderGateway); ToolDispatcher/resolveSafe/security; cross-platform (Windows); error resilience; type hygiene (as any); UI state isolation (per-run stores); caps, Orchestrator, treeKill, RunStateObserver.  
**Process:** Read context (README.md, PROJECT-REVIEW.md 2026-07-03, docs/STATUS.md, known-limitations.md, active-work.md). list_dir on ., server/src, web/src, shared/src, server/src/swarm/blackboard, brainOverseer/. Extensive greps for "as any", "catch\s*\{", process\.(kill|exec|spawn), fs\./path\., resolveSafe, TODO/FIXME (src only, non-test). In-depth reads of: v2Adapters.ts, WorkerPipeline.ts, resolveSafe.ts, ToolDispatcher.ts, treeKill.ts, Orchestrator.ts (start/stop/ActiveRun), pickProvider.ts, ProviderGateway.ts, RunStateObserver.ts, TodoQueue.ts, caps.ts, BlackboardRunner.ts (key paths), workerRunner.ts, auditorRunner.ts, contextBuilders.ts, ActiveRun.ts, applyHunks.ts, clonePathGuard.ts, startupHealthCheck.ts, SwarmStoreProvider.tsx, store.ts, applyEvent.ts, App.tsx (routes), blackboard runners/helpers, brain* files. Compared against July 3 findings; used git log for recent activity (type fixes, hybrid/brain-os, CI). No code changes made.

## Summary

The July 3, 2026 review remains largely accurate with only minor deltas. The architecture is solid for concurrent blackboard/council runs, V2 substrate (TodoQueue + WorkerPipeline + pure applyHunks + git CAS), Brain-as-OS (monitoring/provisioning), per-run isolation, and provider abstraction. Recent activity (type hygiene PR, hybrid planning fixes, brain background ticker) shows continued polish. Key July 3 bugs partially addressed: cross-platform kill (now uses treeKill/killByPid), Orchestrator cleanup improved via ActiveRun RAII. However, many issues linger (casts, delete awkwardness, module-level caps, bare catches, Unix-specific healthcheck). New/updated findings center on remaining type escapes in auditor/batch paths, outdated comments in delete handling, singleton store leakage risk in legacy paths, and exec usage in ToolDispatcher/startup. No critical new races in CAS/apply or Brain safety found; correctness holds in tested blackboard paths. Cross-platform (Windows) and security (paths/exec) still have gaps. Overall: production-ready for core blackboard on POSIX with auditor gating; hardening needed for full Windows reliability, type safety, and legacy cleanup.

## Strengths

- **Substrate robustness post-deltas**: WorkerPipeline + v2Adapters + applyHunks cleanly handle hunks (incl. delete op), CAS via git anchors, verify gates, auditor batching (skipCommit + single commit). TodoQueue supports pending-commit/approve/reject/fail idempotency (noted in active-work). RunStateObserver + shared runStateMachine provide clean V2 state.
- **Isolation improvements**: ActiveRun.ts now centralizes RAII (stop releases locks/monitors/persister/amendments). SwarmStoreProvider + applyEventToStore + runId guards achieve per-run Zustand + WS isolation (context-or-singleton fallback explicit).
- **Cross-platform progress**: treeKill.ts + killByPid fully handle win32 (taskkill /T /F) + POSIX; v2Adapters realVerifyAdapter and worker paths now call it (addresses July 3 Issue 1). resolveSafe handles \\/ splits.
- **Security layering**: resolveSafe (lexical + realpath walk + .git + depth), ToolDispatcher profiles + checkBuildCommand, clonePathGuard + known parents, auditorOnlyMutations guard in applyAndCommit. No worker direct writes.
- **Brain/observability**: Provisioner, brainService with pressure-aware agentCount, continuous monitoring ticker. Caps watchdog (5s), conformance/drift, cost caps. Per-run token attribution.
- **Code/test investment**: Pure modules (applyHunks, caps, runStateMachine), heavy .test.ts coverage for CAS/replan/verify/queue. Recent type fixes reduce implicit any.
- **Docs accurate**: STATUS/active-work/known-limitations correctly reflect E3, Brain librarian role (self-upgrader stubbed), concurrent runs, hybrid planning, auditor-gated writes.

## Issues

### Issue 1 -- Severity: bug (updated/resolved since 2026-07-03)
- File: server/src/swarm/blackboard/v2Adapters.ts:96 (and realVerifyAdapter:80-105)
- Description: July 3 POSIX-only process.kill(-pid) reported; now replaced with `killByPid(cp.pid)` (treeKill.ts). Cross-platform (taskkill on win32, SIG on POSIX) + double-kill fallback. v2Adapters comment explicitly notes the replacement.
- Suggestion: Add Windows-specific integration test for verify timeout (e.g. long-running cmd). Keep using treeKill/killByPid consistently.
- Status: resolved (with minor follow-up suggestion)

### Issue 2 -- Severity: suggestion (updated)
- File: server/src/swarm/blackboard/WorkerPipeline.ts:170-183 (and 230-245 revert); v2Adapters.ts:30-45
- Description: Delete handling (newText === "" or op:"delete" from applyHunks) now routes to fsAdapter.write("") → unlink in real adapter. applyHunks.ts:86-88 supports "delete" producing "". However, comments remain outdated ("we need to delete", "write empty then let git", "we don't have a delete adapter"); revert path skips created files (leave dirty on verify fail); no explicit git rm in realGitAdapter. Still works for CAS but fragile for concurrent/empty-file edge.
- Suggestion: Clean comments. Add explicit delete path in FilesystemAdapter + GitAdapter (e.g. fs.unlink + git rm --cached in commit). Add tests for delete + verify-revert + CAS on deletes.
- Status: open (partially mitigated)

### Issue 3 -- Severity: suggestion (updated)
- File: server/src/services/Orchestrator.ts:680-930 (start), 550-560 (stopRun), 950-990 (stopAll/stop), 820-890 (ActiveRun construction); server/src/services/ActiveRun.ts:65-110
- Description: July 3 complexity + leak risks noted. Now uses ActiveRun RAII wrapper (stop() centralizes runner.stop + monitors + persister + releaseLock + amendments.close). start() uses activeRun.stop() on partial failure (920). Per-run runs Map + startInProgress gate. Still complex try/finally, cloneLock, persister, tokenTracker, brain registration; some catch {} swallows (releaseLock warn only).
- Suggestion: Keep ActiveRun as single ownership; audit remaining direct runs.delete paths and proxy attribution in error branches. Add runId to all error events.
- Status: open (improved, still complex)

### Issue 4 -- Severity: suggestion
- File: server/src/swarm/blackboard/resolveSafe.ts:30-70 (lstat/realpath walk); callers: ToolDispatcher.ts:139, v2Adapters.ts:26, workerRunner.ts, contextBuilders.ts
- Description: Strong defense (lexical + realpath + .git + 1000-depth). TOCTOU window remains under concurrent workers (or external) between resolve and CAS commit (git provides the real safety). Windows junctions/UNC/realpath differences possible (path.resolve + split /\\ helps but not exhaustive).
- Suggestion: Re-validate post-resolve in critical write paths or rely on git hash CAS (current). Add Windows symlink/junction tests.
- Status: open

### Issue 5 -- Severity: suggestion (lingering + new instances)
- File: server/src/routes/swarm.ts:177-178,351,355,525,1261 (t as any, parsed.data as any, tokenTracker as any); server/src/swarm/blackboard/auditorRunner.ts:247,372-379,441,491,494 (todo as any, hunks as any); server/src/swarm/blackboard/contextBuilders.ts:496-510 (hunks as any, result as any, verify as any); server/src/providers/ProviderGateway.ts:257 (job.opts as any); server/src/services/Orchestrator.ts:464,502 (as any); server/src/swarm/blackboard/brainOverseer/provisioner.ts:93 (insight as any); web/src/App.tsx:340, web/src/hooks/useSetupForm.ts:131-157, web/src/state/SwarmStoreProvider.tsx:138
- Description: July 3 flagged casts. Recent type-fix commit cleaned some BrainConfig, but many remain for board todos, proposedHunks, pressure(), reqId, hub emit, auditor batch apply. Bypass type safety in hot paths (auditorOnlyMutations, batch commits).
- Suggestion: Define interfaces (e.g. ProposedTodo extension, PressureTracker). Use type guards or narrow returns from applyAndCommit. Eliminate prod casts.
- Status: open

### Issue 6 -- Severity: suggestion
- File: server/src/tools/ToolDispatcher.ts:260-270 (bashTool: execAsync(command, {cwd, timeout...} no shell:false)); 40-100 (PROFILES, defaultToolsForProfile); server/src/swarm/blackboard/buildCommandAllowlist.ts; startupHealthCheck.ts:44 (execSync("df -B 1 ."))
- Description: Allowlist + cwd + timeout good, but exec (shell:true) permits arg injection risks or quoting surprises vs spawn argv. No per-agent bash rate/count budget. startupHealthCheck df is Unix-only (fails silently on Windows, no equivalent disk check). Bash exposed only for swarm-builder (planner/auditor use read only).
- Suggestion: Switch bash to spawn with arg parse (shell:false). Add platform disk check (wmic or fs.statfs). Add execution budgets + tests for injection attempts.
- Status: open

### Issue 7 -- Severity: suggestion (lingering)
- File: server/src/index.ts:457-468 (global unhandled catch {} ignore); server/src/services/ActiveRun.ts:77-105 and many runner paths (bare catch {}); Orchestrator cleanup; capManager.ts, broadcast etc.
- Description: Broad ignores for monitors/release/persister/proxy. Global handlers log/broadcast but limited runId correlation. errorTaxonomy exists but not uniform.
- Suggestion: Tag all top-level errors with runId. Prefer structured logging over silent catch. Centralize in ActiveRun/Orchestrator.
- Status: open

### Issue 8 -- Severity: suggestion
- File: server/src/swarm/blackboard/caps.ts:7-16 (WALL_CLOCK_CAP_MS etc exported from config at import); capManager.ts:88-140; BlackboardRunner.ts:614 (checkAndApplyCaps)
- Description: July 3 exact. Module-level re-eval at load; per-run overrides via cfg.wallClockCapMs win in some paths but constants used directly. Tick accumulator good, but dual legacy + V2 state.
- Suggestion: Make all cap values strictly per-run (no top-level exports). Unify decisions on V2 RunStateObserver.
- Status: open

### Issue 9 -- Severity: nit
- File: server/src/swarm/blackboard/brainOverseer/selfUpgrader.ts (stub); provisioner.ts:70-95; brainService.ts; Orchestrator.ts:730 (brain register)
- Description: Self-upgrade removed (per docs/active-work). Provisioner still uses cast + dynamic agentCount (8/4 based on pressure). No explicit lock vs concurrent user starts beyond getActiveRunCount(). Background ticker added recently.
- Suggestion: Keep stubs minimal. Add stronger "no startInProgress" gate for brain provisioner.
- Status: open (per design)

### Issue 10 -- Severity: suggestion
- File: server/src/services/Orchestrator.ts:460 (listActiveRuns as any); web/src/App.tsx:130-160 (RunRouteWrapper + legacy / + AppMain mixing singleton); web/src/state/store.ts:615-647 (singletonStore + useSwarm.getState always singleton; useSwarmSocket dispatch targets singleton)
- Description: July 3 noted. Per-run Provider good (own WS + applyEventToStore with guard), but legacy "/" + hooks like useSwarmSocket still hit singleton; some dispatch paths risk cross-run if guards miss. App casts for wallClock/ambition.
- Suggestion: Phase out singleton usage. Ensure all event dispatch goes through run-scoped apply. Add tests for concurrent run event isolation.
- Status: open

### Issue 11 -- Severity: nit (new)
- File: server/src/startupHealthCheck.ts:44-60; server/src/swarm/blackboard/resolveSafe.ts:20 (lex split); v2Adapters.ts:160 (git raw)
- Description: execSync df always fails (caught) on Windows — no disk warning path. Path handling uses mixed sep checks. Git commit identity forcing is good but error paths log to console.warn.
- Suggestion: Platform-aware disk (or use fs.statvfs-like). Normalize paths early. Consistent logging.
- Status: open

### Issue 12 -- Severity: nit (new/observed)
- File: server/src/swarm/blackboard/WorkerPipeline.ts:100-110 (auditorApproved guard comment-only); contextBuilders.ts:482 (dynamic import applyAndCommit); capManager.ts:101 (non-null ! after undefined check)
- Description: Auditor guard is comment + runtime flag (defense in depth); dynamic imports in hot auditor path add fragility. Some ! after guards.
- Suggestion: Make auditorApproved a hard config-time or type-level enforcement where possible. Avoid runtime ! where feasible.
- Status: open

### Issue 13 -- Severity: nit
- File: Multiple blackboard (BlackboardRunner.ts + extracted in runnerHelpers/contextBuilders/workerRunner); shared/runStateMachine.ts
- Description: V2 is primary but BlackboardRunner retains large extracted/legacy flag coordination. Wire compat + observer exist. No full cutover conformance asserted on every transition.
- Suggestion: Accelerate or add strict V2-only mode + diff test.
- Status: open (per July 3)

## Additional Observations

- **Deltas since 2026-07-03**: Type cleanup commit (explicit BrainConfigPatch, CI preset fixes); hybrid planning robustness (planningPreset choice, pipeline stop/summary); brain-os background monitoring (startBackgroundMonitoring + 60s ticker, pressure integration). ActiveRun introduced (helps Issue 3). v2 kill path updated. Delete op added to applyHunks. No major correctness regressions; blackboard CAS/apply/delete paths stable. Brain now strictly librarian (no self-patching).
- **Concurrency/Brain safety**: No new races found in TodoQueue CAS (real safety in git applyHunks anchors), auditor batch (in-mem apply + one commit), or provisioner gating. Per-run ActiveRun + hub good. ProviderGateway queues (64 cap, brain priority) + pressure protect.
- **Error resilience**: Transient auditor/planner catches noted in docs; many more bare {} in practice. Good watchdog for caps/verify.
- **UI**: Strong per-run design (Provider + scoped WS + apply guard). Legacy singleton + direct .getState on singleton remains for review/replay/history. No obvious cross-run leaks in scoped paths.
- **Security/paths/exec allowlist**: resolveSafe + allowlist + auditor gating solid. Web tools opt-in only for planners (webTools flag). No general internet for workers.
- **Tests/CI**: Extensive. Recent commits focused on CI untracked fixes. Run `npm test` + verify-ci before changes.
- **No findings in**: Shared pure (runStateMachine, extractors, workerHunks) — clean. Most blackboard prompts/types good. No unwrap() abuse or heavy cloning flagged in critical paths.
- **Lingering from July 3**: Issues 4-13 largely unchanged except partial mitigations above. July 3 summary verdict holds.

## Verdict

July 3 review is still accurate with only minor deltas (kill fixed, ActiveRun added, some type hygiene, hybrid/brain updates). List only new/updated findings above; no critical new bugs. Core blackboard (CAS/apply via WorkerPipeline + git, TodoQueue, auditor batch) is correct and resilient. Prioritize: eliminate remaining `as any` (esp. auditor/hunks), clean delete handling/comments, make caps per-run only, add Windows verify/disk tests, reduce singleton reliance in UI. Cross-platform (Windows) and error hygiene remain the largest gaps. File written to ./PROJECT-REVIEW-2026-07-04.md. Verdict: solid production substrate for blackboard on supported platforms; targeted hardening will make it robust everywhere.

---

## 2026-07-04 Fixes Applied (this session)

- **Delete path (Issue 2 + deep drill)**: Extended `FilesystemAdapter` with optional `delete(path)`. Real adapter implements explicit unlink. Pipeline now prefers `.delete()` for `newText===""` (from applyHunks delete op); falls back to `write("")` for compat. Updated fakes in WorkerPipeline.test.ts + v2Integration.test.ts (delete removes Map entry; write("") also deletes). Cleaned stale comments in WorkerPipeline.ts and revert logic. Updated test comment.
  - Result: WorkerPipeline unit tests 18/18 ✅. Behavior improved for explicit deletes + test fidelity.
- **Platform / disk (Issues 6 + 11)**: `startupHealthCheck.ts` now has cross-platform free-space check (wmic + PowerShell fallback on win32; df on POSIX). Added explanatory comment in ToolDispatcher bashTool.
- **Type hygiene (Issue 5)**: Removed several `as any`:
  - `routes/swarm.ts`: todos loop now uses imported `Todo` type (staleReason, commitTier).
  - `contextBuilders.ts`: hunks cast to `Hunk[]`, verify shape fixed, result fields narrowed with inline types (removed some `as any`).
- **Caps awareness (Issue 8)**: Added review note + future-work comment in `caps.ts`.
- **Checks**: `npm run typecheck` ✅, `npm -w server run test` (WorkerPipeline focused) ✅, `npm run build` ✅ (full production build succeeded). Full integration suite hits pre-existing Windows `/bin/bash` + git init requirements in some Orchestrator tests (documented limitation, not regression from these changes).

No other files were modified. These are reversible, targeted, test-verified improvements addressing several of the 13 issues. Larger items (full UI singleton removal, complete caps refactor, broad catch hygiene, V2 legacy cutover) remain for follow-up.
