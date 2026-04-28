# Bonus 9 — orchestrator-worker (regular) — PASS

- **runId**: `b5c7fafa`
- **preset**: orchestrator-worker (regular, NOT deep), 4 agents, 3 rounds
- **outcome**: `completed` in 2m 31s
- **errors**: 0 across all agents
- **commits**: 0 (OW-regular is also discussion preset; only OW-DEEP attempts file changes)

## Per-agent

- agent-1 (orchestrator/lead): 6 turns (planning + revisions), mean 12.6s
- agents 2-4 (workers): 3 turns each
- 1.52M prompt tokens / 14.9k response tokens

## Comparison to ow-deep failure

OW-regular **PASSED** while OW-deep earlier **FAILED** with "orchestrator-silenced (2 consecutive empty plans)". This narrows the failure mode: OW-deep has a stricter empty-plan detector that fires on the same model behavior OW-regular tolerates. The deep variant's stricter checks are a feature, not a bug — but they need a more lenient retry strategy when the model emits empty plans.

Effectively confirms: discussion presets and lenient orchestrator presets all PASS with the same model that fails strict-parsing presets.
