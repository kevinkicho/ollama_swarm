# Model Behaviors

Observed behaviors and characteristics of different models when used inside this swarm system.

**Note:** This is empirical and changes with model versions. Treat as guidance, not guarantees.

## Ollama Local Models

- Generally good at following structured output when prompted strongly.
- Smaller models can be "lazy" on broad exploration tasks (mitigated by mechanical slicing in map-reduce).
- Context handling varies; long transcripts can cause degradation.

## Ollama Cloud (:cloud models)

- Reliable for discussion and synthesis.
- Good tool use when the planner profile is used.
- Token tracking is captured via the local proxy.

## OpenCode Go / Anthropic / OpenAI

- Strong reasoning and structured output.
- Higher cost → use for high-value roles (planner, auditor, judge, aggregator) and cheaper models for workers.
- Tool calling (Anthropic/OpenAI) is routed through the provider abstraction.

See also the outcome recommender data and `docs/swarm-patterns.md` for which models tend to win in which presets.
