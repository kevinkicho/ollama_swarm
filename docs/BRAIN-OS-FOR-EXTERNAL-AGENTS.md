# Brain-OS for External Agents

This guide helps external LLM agents, scripts, or tools use **Brain-as-OS** to get intelligent assistance for swarm configuration, preset selection, run steering, and analysis.

Brain acts as a librarian / master-admin: it understands use-cases from the tables in [`docs/swarm-patterns.md`](swarm-patterns.md) and [`docs/STATUS.md`](STATUS.md), uses historical outcome data, and helps you pick the right preset with explanations.

## Key Communication Channels

- **Conversational help**: `POST /api/swarm/brain/chat`
  - Send natural language goals.
  - Pass `runContext` for live runs (recent transcript summaries, board state, phase).
  - Use `structured: true` (body or `?structured=true`) to get parseable `recommendation` + `config`.
  - Example for "explain options": include "explain all options for my goal" in the message, or use `?explain=options`.

- **Proactive suggestions**: `POST /api/swarm/brain/suggest`
- **History**: `POST /api/swarm/brain/chat-history` (persists per-run)
- **Preset recommendation with data**: `GET /api/swarm/outcome/recommend?directive=...`
  - Returns best preset + rationale + real stats (median/avg scores from past runs).
- **Control**: `/api/swarm/start`, `/api/swarm/amend`, `/api/swarm/reconfig` (extend rounds/cap/budget mid-run), per-run `/status`, `/stop`, etc.
- **Observation**: `/api/swarm/run-summary`, `/memory`, event logs, `/brain/activity`, `/brain/proposals`.

## Use-Case Tables (source of truth for Brain)

See the webTools guidance in README ("Using for Scientific Research & Internet Work") and the full preset matrix in `STATUS.md`. Brain's prompt is built from the shared `server/src/swarm/presetGuide.ts` (no duplication).

Examples:
- Research + write artifacts → council (or pipeline preset) + blackboard + `webTools: true`
- Broad literature scan → `map-reduce`
- Debate / "should we" → `debate-judge` or `council`
- Exploration → `stigmergy`

## How to Talk to Brain Effectively

1. Be explicit about the goal and constraints (time, cost, write vs read-only).
2. Mention preferred preset family if you have one.
3. For live runs, pass recent context so Brain can suggest mid-run amendments.
4. Use `structured: true` when you need machine-readable output (config JSON).

Brain will reference real historical data when available and fall back to the pattern catalog.

See also `docs/STATUS.md` (Brain-as-OS section) and the example loops in `examples/brain-agent-loop.mjs`.
