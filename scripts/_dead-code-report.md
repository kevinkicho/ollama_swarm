# Dead-code analysis (2026-07-10)

Scanner: `scripts/_dead-code-scan.mjs` (relative-import graph + export name heuristic).
Package imports (`@ollama-swarm/shared/...`) are not resolved — those appear as false positives.

## Removed this pass (never imported; zero production callers)

### Server
| File | Why dead |
|------|----------|
| `services/PortAllocator.ts` | Post-E3 no per-agent ports |
| `services/brainOptimization.ts` | Unwired plan skeleton |
| `services/largeFileHandler.ts` | Unwired plan skeleton |
| `swarm/SubRunProtocol.ts` | Unwired Direction-2 protocol |
| `swarm/multiRepo/MultiRepoConfig.ts` | Unwired multi-repo config |
| `swarm/decomposer/TaskDecomposer.ts` | Unwired Direction-4 decomposer |
| `swarm/blackboard/brainOverseer/councilBrainAdapter.ts` | Self-upgrade / council-brain path unused |
| `swarm/blackboard/brainOverseer/patchCache.ts` | Patch-generation cache unused after patch UX removed |
| `swarm/resilience/index.ts` | Unused barrel (callers use leaf modules / re-exports) |
| `swarm/resilience/attemptRecorder.ts` | Duplicate of private helpers in `failoverChain.ts` |
| `testHelpers/faultInjection.ts` | Never used even by tests |

### Web
| File | Why dead |
|------|----------|
| `components/PatchMonitorPanel.tsx` | Brain self-upgrade patch UI removed |
| `components/PatchPreviewPanel.tsx` | same |
| `components/RunHistoryViewer.tsx` | Orphan UI; history lives in `RunHistory*` |
| `components/SystemHealthDashboard.tsx` | Orphan UI |
| `setup/ModelAvailabilityBanner.tsx` | Never wired into SetupForm |
| `setup/SettingsHistory.tsx` | Never wired |
| `setup/StarterDirectives.ts` | Never wired |
| `transcript/ExecutionGrid.tsx` | Never imported |
| `transcript/ThoughtsBlock.tsx` | Superseded by `AgentThinking.tsx` |
| `hooks/useRunScopedWebSocket.ts` | Never adopted (comment-only references) |
| `hooks/useSetupFormState.ts` | Never wired |
| `hooks/useSwarmSettings.ts` | Paired with dead SettingsHistory |
| `services/transcriptPersistence.ts` | Never wired |

~1.5k LOC of orphan modules removed. Stale comments updated (PortAllocator, ThoughtsBlock).

## Remaining “never imported” after cleanup (false positives)

- `shared/src/planningSubphase.ts` — imported via `@ollama-swarm/shared/planningSubphase`
- `shared/src/swarmControl/toolFailureTrack.ts` — imported via package path

## “Only imported by tests” — mostly **dormant quality levers**, not safe deletes

Many have `RunConfig` flags and unit tests but no runner call sites yet (or only tests). Examples:

- `bestOfNTurn`, `dynamicRolePicker`, `dissentPreservation`, `selfCritique`
- `councilReconcile`, `swapSidesBiasCheck`, `pheromoneDecay`, `midCycleBroadcast`
- `hunkRag`, `failurePatternSeed`, `preflightDryRun`, `agentMentionContract`
- `OTEngine`, `testScaffolding`, `degradationFallback` (re-export façade)

**Do not delete** without product decision: they are feature inventory with tests.

`progressSignature.ts` is new (guard work) — tests-only until more call sites.

Shared modules listed as “test-only” by the scanner are often **false positives** (web/server import via `@ollama-swarm/shared/...`).

## Known live no-ops (not deleted)

- `SIBLING_MODELS = {}` + `withSiblingRetry` — empty map short-circuits; still used as structure for failover swap. Documented in README.
- `spawnAgent` — single API (2026-07-10 rename; former `spawnAgentNoOpencode` alias removed).

## Quality levers (2026-07-10 wiring pass)

**Wired (API schema + runner):**
- `failurePatternSeed` → blackboard `buildSeed`
- `preserveDissent` → council synthesis
- `selfCritique` + `swapSidesBiasCheck` → debate judge turn
- `pheromoneDecay` → stigmergy explorer candidates / pick hint
- `midCycleBroadcast` → map-reduce sequential mapper path

**Still library-only (schema accepted; not all runners consume yet):**
- `bestOfNTurn`, `dynamicRolePicker`, `mentionContracts`, `preflightDryRun`, `hunkRag`, `councilReconcile`
- `OTEngine`, `testScaffolding`, `agentMentionContract` helpers

## Export-level noise

Heuristic reports hundreds of “unused exports” — mostly **types**, **test hooks** (`__reset*`), and **public API** of tightly coupled modules. Manual review required before pruning; not bulk-deleted this pass.

## How to re-scan

```bash
node scripts/_dead-code-scan.mjs
# writes scripts/_dead-code-report.json
```
