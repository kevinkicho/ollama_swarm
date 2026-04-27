# Architecture Decision Records (ADRs)

Short, dated docs explaining non-obvious "why this and not that"
choices. Each ADR has the same shape:

- **Decision** — one sentence, present tense
- **Context** — what made the decision necessary
- **Alternatives considered** — what we rejected and why
- **Trade-offs** — what this costs us
- **When to revisit** — what would invalidate the choice

If you propose changing one of these decisions, write a successor
ADR rather than editing the original. Old decisions stay readable
so future agents can trace the reasoning chain.

## Index

- [001 — One opencode subprocess per agent](./001-per-agent-subprocess.md)
- [002 — Search/replace hunks instead of full-file replacement or unified diffs](./002-search-replace-hunks.md)
- [003 — Blackboard is the only write-capable preset](./003-blackboard-only-write.md)
- [004 — V2 substrate ships parallel-track, not big-bang cutover](./004-v2-parallel-track.md)
- [005 — Keep opencode (for now) — don't bypass for non-blackboard runners yet](./005-keep-opencode-for-now.md)
