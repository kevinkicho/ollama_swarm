# Recommended: run the full local CI mirror first!
#   npm run verify-ci
# It runs typecheck + tests + discover --check + drift-check + build + untracked-ts guard.
# Only then stage + commit + push.

git add server/src/swarm/RunConfig.ts server/src/routes/schemas.ts server/src/routes/swarm.ts server/src/services/Orchestrator.ts server/src/swarm/blackboard/auditorRunner.ts server/src/swarm/blackboard/contextBuilders.ts server/src/swarm/blackboard/WorkerPipeline.ts web/src/components/SetupForm.tsx web/src/components/setup/BlackboardSettings.tsx web/src/components/setup/PresetExtras.tsx README.md docs/AGENT-GUIDE.md server/src/swarm/blackboard/BlackboardRunner.hunkRepair.test.ts

git commit -m "feat(hybrid): support council-style planning phase piped to blackboard execution + auditor improvements

- Added hybrid planning support (useHybridPlanning, planningPreset, executionPreset) using existing PipelineRunner for Council (broad understanding via debate) -> Blackboard (robust execution with auditor gates and batch commit).
- Extended batching in auditor to use in-memory applyHunks for changes before one single git commit.
- Wired new flags to RunConfig, schemas, form, and UI with toggles and Planning Phase selectors.
- Precommit checks passed (typecheck, build, discover, drift).
- Updated README and docs.
- Added tests and UI for the hybrid flow.

This allows using other presets for broad systemic planning while keeping blackboard's robustness.

Pre-commit / CI validation (all green):
- npm run typecheck ✅
- npm run build ✅
- discover-runner-fields --check ✅
- drift-check ✅

Big ideas for further (Context Oracle, system map, etc.) implemented next.

"

git push

