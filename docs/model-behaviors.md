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

### DeepSeek v4 (`deepseek-v4-flash:cloud`, etc.)

- Often prefixes structured JSON turns with think-tag blocks (handled by `extractThinkTags`).
- On **explore** turns (contract/planner with tools), may emit **nested `<function>` pseudo-tool XML** instead of executing tools via the SDK — e.g. `<function><function name>read</function><parameter name="path">…</parameter></function>`. Stripped by `extractToolCallMarkers`; transcript thinking panel summarizes as "Intended tool calls".
- JSON envelope usually recoverable on attempt 2 (explore → emit-only retry); `no-progress` from planner grounding is often a path-truncation issue, not repair failure (see `docs/postmortems/run-94224a3e.md`).

## OpenCode Go / Anthropic / OpenAI

- Strong reasoning and structured output.
- Higher cost → use for high-value roles (planner, auditor, judge, aggregator) and cheaper models for workers.
- Tool calling (Anthropic/OpenAI) is routed through the provider abstraction.

See also the outcome recommender data and `docs/swarm-patterns.md` for which models tend to win in which presets.
