# ADR 001 — One opencode subprocess per agent

**Status:** accepted
**Decided:** 2026-04-23 (per Kevin's confirmation)
**Last verified:** 2026-04-27

## Decision

Each agent in a swarm gets its own `opencode serve --port N` subprocess.
N agents means N distinct subprocesses on N distinct ports, each with
their own SDK client + session.

## Context

When spawning N agents, the obvious alternative is to share one opencode
server across all agents and just create N sessions on it. That would
save ~50MB of RAM per extra agent + reduce port allocation churn + cut
warmup-ping count.

## Alternatives considered

1. **One opencode subprocess + N sessions.** Cheaper per-agent, but
   sessions on the same opencode share a process-wide event stream and
   tokenizer state. A slow first-prompt on agent-A would block (or at
   least throttle) the SSE pipeline that agent-B is also consuming.
   Failure modes correlate across agents.

2. **One opencode subprocess + one session, agents discriminate via
   prompt prefix.** Even worse: agents would see each other's
   in-flight token streams.

3. **Per-agent subprocess (this ADR).** Each agent's failures are
   contained: a stuck SSE on agent-1 doesn't affect agent-2. Cold
   starts are independent. Resource usage is higher but bounded
   (typical: 5 agents × 50MB = 250MB).

## Trade-offs

- **Cost:** ~50MB RAM per agent baseline + each agent independently
  cold-loads on first prompt (the "agent-2 starvation" pattern in
  `feedback_run_patterns` — when N parallel cold-starts hit cloud at
  once, ONE of them tends to lose the scheduler race).
- **Win:** complete isolation. PID tracking, port allocation, orphan
  reclamation, kill-and-respawn all happen per-agent without
  coordination.

## When to revisit

- If agent count goes >10 routinely. At that scale, RAM becomes real.
- If we ship the V2 path that drops opencode entirely (see ADR 005).
  Then "subprocess per agent" becomes "one in-process session-state
  object per agent" and the cost question evaporates.
- If opencode itself adds session-isolation guarantees that match
  per-process.

## References

- `feedback_data_before_theories` memory ("1-subprocess-per-agent is
  intentional, don't propose collapsing it")
- `server/src/services/AgentManager.ts:spawnAgent`
- `docs/known-limitations.md` — "Per-agent opencode subprocess
  amplifies cloud-variance tails"
