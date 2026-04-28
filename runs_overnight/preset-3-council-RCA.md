# Preset 3 — council — PASS (no RCA needed)

- **runId**: `481576df`
- **preset**: council, 4 agents, 3 rounds
- **outcome**: `completed` in 1m 15s
- **per-agent**: agent-1 (drafter+lead) 4 turns, agents 2-4 (drafters) 3 turns each
- **errors**: 0 rejected, 0 repairs, 0 prompt errors
- **tokens**: 988k prompt / 9.5k response
- **commits**: 0 (council is a discussion preset, not write-capable)

## What worked

The first preset to complete cleanly tonight. The 4-drafter discussion produced a synthesis with no parser failures and no model crashes. Council's lower failure surface (no contract-and-todos pipeline like blackboard, no orchestrator-silenced detection like ow-deep) means the model failure modes from preset 1 + 2 didn't surface.

This is also EVIDENCE that the issue isn't model-wide — glm-5.1 can produce coherent drafts when not asked to emit strict JSON.
