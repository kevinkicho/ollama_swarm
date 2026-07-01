# Pending Work — Unfinished Items from Archived Plans

Generated: 2026-06-30

## Plan 4: context-window-utilization.md — PARTIAL

Core budget system implemented. Worker prompt uses `fullFileMode`. Other prompts still use hardcoded limits.

### What's done
- `modelContextBudget.ts` — `getModelBudget()` returns per-model budgets
- `workerRunner.ts` — passes `fullFileMode` to seed
- `worker.ts` prompt — shows full file when `fullFileMode` is true

### What's not done
| File | Hardcoded Limit | Needs Budget |
|------|-----------------|--------------|
| `prompts/planner.ts` | README capped at 4000 chars | Use `budget.fullFileMode ? 20_000 : 4_000` |
| `prompts/auditor.ts` | File state 60,000 chars, transcript 40 items | Use budget for both |
| `councilPromptHelpers.ts` | Repo files 60-80 paths | Use budget for `maxRepoFiles`, `maxDirs` |
| `prompts/firstPassContract.ts` | No budget used | Thread budget through |
| `windowFile.ts` | No `fullFileMode` option | Add full-file branch |

---

## Plan 5: council-powered-brain.md — PARTIAL

Council adapter created. Council bugs remain unfixed.

### What's done
- `councilBrainAdapter.ts` — `buildCouncilBrainDirective()` and `buildCouncilBrainConfig()`

### What's not done
| Bug | File | Status |
|-----|------|--------|
| Bug 1: `synthesizeStandup` discards parsed todos | `CouncilRunner.ts:527-561` | Still broken — output never parsed or posted |
| Bug 2: Dead `tryBrainFallbackWorker` function | `councilWorkerRunner.ts:231-278` | Still exists |
| Bug 3: Unreachable `unmetCount === 0` check | `CouncilRunner.ts:456-463` | Still dead code |
| Bug 4: JSON parse errors silently swallowed | `CouncilRunner.ts:484,550` | `catch { /* ignore */ }` still present |
| Bug 5: Leaked AbortController in `synthesizeStandup` | `CouncilRunner.ts:554` | Still leaked |
| Bug 6: Greedy `[...]` extraction in `parseJsonArrayFromResponse` | `councilUtils.ts:45-48` | Still greedy |
| Missing: `proposalReviewer.ts` | `brainOverseer/` | Not created |

---

## Plan 4: brain-system-overseer.md — PART 2 (self-upgrade)

Core brain is wired. Self-upgrade workflow not started.

### What's not done
| Component | File | Status |
|-----------|------|--------|
| Self-upgrade lifecycle manager | `brainOverseer/selfUpgrader.ts` | Not created |
| Terminal-style upgrade UI | `web/src/components/UpgradeMode.tsx` | Not created |
| Patch preview with diff | `web/src/components/UpgradePreview.tsx` | Not created |
| Server restart after patches | `lifecycleRunner.ts` | Not implemented |
| Safety measures (confidence threshold, rollback, dry-run, backup) | Various | Not implemented |
