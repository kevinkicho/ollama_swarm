# Preset 6 — map-reduce — PASS

- **runId**: `93ee8115`
- **preset**: map-reduce, 4 agents, 2 cycles
- **outcome**: `completed` in 1m 6s
- **errors**: 0 across all agents
- **commits**: 0 (map-reduce is discussion preset)

## Per-agent

- 4 agents × 2 turns each (mappers + reducer)
- Mean latency 10-18s
- 555k prompt tokens / 11.6k response tokens

Map-reduce is the simplest of the discussion presets — N mappers → 1 reducer per cycle. Worked cleanly with no parser failures. The shared cycle-2 synthesis tagging (mapreduce_synthesis kind) flowed through to the bubble correctly.
