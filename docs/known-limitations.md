# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

---

## Blackboard planner now uses `swarm-read` (resolved 2026-05-09)

**Previous state:** Blackboard's planner and auditor used `swarm` profile (tools
disabled). The planner produced contracts with zero file inspection — working
only from the seed context, unable to read/grep/glob the actual repo.

**Current state:** Planner, auditor, and contract builder now use `"swarm-read"`
profile (read/grep/glob/list tools enabled). The planner prompt explicitly
instructs tool use: "You have `read`, `grep`, `glob`, `list` tools on the
cloned repo. USE THEM before emitting TODOs." Workers remain on `"swarm"` —
they must return JSON diffs, not call tools directly. A 3-file read limit
per planning turn prevents context blow-up.

**Files:** `plannerRunner.ts:81`, `auditorRunner.ts:105`, `contractBuilder.ts`
(`"swarm-read"` agent profile) · `prompts/planner.ts:262` (TOOLS section) ·
`prompts/firstPassContract.ts:162` (tool instruction)

---

## Discussion presets have opt-in write capability (2026-05+)

**Current state:** Discussion presets support `cfg.writeMode: "single"` (synthesizer produces hunks after discussion). Blackboard has native concurrent writes. Council and others route through the same WorkerPipeline when writeMode is enabled. The pipeline preset reliably chains phases.

**What's still limited:**
- True multi-writer during turns (`writeMode: "multi"`) is not the default path for most presets.
- Conflict resolution for overlapping edits is basic (CAS in blackboard, vote reconciliation elsewhere).

**When this would need revisiting:** If the product direction moves toward highly parallel editing agents rather than planner → workers or post-discussion synthesis. Brain proposals currently favor small, auditable changes.

---

## Planner does double duty as the replanner

**Choice:** when a todo goes stale, the **planner agent** handles the replan.
We do not spawn a dedicated replanner agent.

**Why:** the planner already has the repo context loaded and a system prompt
that understands the todo shape. Reusing it keeps agent count stable and
token usage low.

**When this would need revisiting:**
- If we want the replanner to run on a different model or with different parameters.
- If the planner's system prompt needs to specialize so hard in one direction that it starts producing worse replans.
- If we hit token-budget pressure where sharing one agent's context across planning and replanning causes context bloat.

Until any of those bite, one agent covers both roles.

---

## Agents have no general internet / web search tools

**Current state (as of 2026-07):** The only tools agents can invoke are local
to the cloned repository via the in-process `ToolDispatcher`:

- `swarm` (default workers in blackboard): **no tools**. Must return clean
  JSON (hunks / answers).
- `swarm-read` (planners, many discussion roles, auditors): `read | grep | glob | list`.
  Limited reads per turn in planning to prevent context explosion.
- `swarm-builder` (build / test roles): above + restricted `bash` (only
  allowlisted commands: npm test, tsc, eslint, etc. No network, no `curl`,
  cwd-bound).

**No web tools exist** for agents: no `web_search`, `browse`, `fetch_url`,
general HTTP, or external API access. The GitHub MCP definitions in
`mcps/grok_com_github/` and the opt-in `MCP_PLAYWRIGHT_ENABLED` (auditor
browser automation) are not wired into the general agent tool dispatch loop.

Directives containing "do a websearch", "find current governmental data
endpoints", "research latest best practices online" etc. are answered
only from the model's frozen training knowledge. Planning with web tools +
`systemMap` + `swarm-read` planner tools give "broad view" *within the repo*
without giving live internet.

**See also:**
- `server/src/tools/ToolDispatcher.ts`
- `server/src/swarm/promptWithRetry.ts` + `roles.ts` (profile assignment)
- Auditor prompts that explicitly document the lack of external tooling.

This is a deliberate security / blast-radius choice. Adding live web access
would require new allowlisting, rate-limiting, and safety work.

---

## Concurrent multi-run execution — resolved (2026-07-02)

**Previous state:** A single global `AgentManager`, `wrappedEmit` getters, and global quota state made `SWARM_MAX_CONCURRENT_RUNS > 1` unsafe.

**Current state:** Each `ActiveRun` owns its `AgentManager`; `wrappedEmit` binds `runId` at construction; WS + client `applyEvent` guards drop cross-run events; per-run quota in `tokenTracker.quotaByRun`; `POST /api/swarm/start` returns `runId` + `navigateTo`; `/runs/:runId` is the primary UI path.

**Remaining edge:** Ollama-proxy quota detection without run attribution still sets `globalOllamaQuota` (informational). Run halt decisions use per-run maps when `runId` is known.

---

## Multi-tenant token attribution — resolved (2026-05-09)

`tokenTracker` now supports per-runId attribution. `UsageRecord` carries a
`runId` field, `totalsInWindow` filters by runId, and `/api/usage?runId=X`
returns per-run aggregates. Concurrent runs can report per-run token totals.
The remaining edge case: interleaved `tokenTracker.add()` calls may capture
the timestamp at insertion time rather than request time — the run-window
filter is approximate for very short runs.

---

## MoaRunner does not use base class spawn/prompt pipeline

**Choice:** MoaRunner re-implements clone+spawn and the prompt pipeline in
`loopBody()` and `runOne()` instead of using `initCloneAndSpawn()` and
`runDiscussionAgent()` from `DiscussionRunnerBase`. This is the only
subclass that diverges from the base pipeline.

**Why:** MoA needs heterogeneous model selection (different models for
proposers vs aggregators, per-proposer model cycling). The base
`initCloneAndSpawn` assumes one model for all agents. The base
`runDiscussionAgent` routes through `promptWithFailoverAuto` with full
observability wiring; MoA's simplified pipeline skips this for throughput.
The divergence is structural, not accidental — normalizing it would require
extending the base class to support per-agent model overrides and optional
observability wiring, which adds complexity to every other runner for the
benefit of one.

**Revisit when:** MoA becomes a primary preset (currently beta), or when the
maintenance burden of the divergence (bug fixes applied to 2 pipelines
instead of 1) exceeds the cost of extending the base class.

---

## Region status dashboard is deferred

**Choice:** No 5-region run-status dashboard (lifecycle / planner / workers /
queue / caps). The statechart analysis confirmed 5 orthogonal regions exist
but they're collapsed into a single "Running" badge in the UI.
