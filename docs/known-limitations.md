# Known Limitations

Deliberate trade-offs in the current build. Each entry names the choice, why
we made it, and what would force us to revisit. Anything that becomes a
*real* problem in practice should graduate out of here into a plan item.

---

## Brain does not auto-start runs by default (2026-07-09)

**Choice:** `SWARM_BRAIN_AUTO_PROVISION` defaults to `false`. `startRunForProposal`
requires `{ approved: true }` unless auto-provision is enabled.

**Why:** Approve-to-provision for release 1.0 — Brain is librarian/operator, not
an unattended run launcher.

**When to revisit:** Trusted continuous improvement loops with capacity caps.

---

## Turn-level Jaccard is not a primary loop halt (2026-07-10)

**Choice:** Whole-run “agents repeating themselves” detection via text Jaccard
(or similar) is **not** used as a primary stop. Empty/junk turns, plan-empty,
resource caps, and board/ledger stuck remain the automated gates.

**Why:** Agents re-reading prior-run logs or refining shared claims often look
“repetitive” while still making progress — Jaccard false-positives halt useful
work. See `docs/decisions.md` and `docs/postmortems/stream-guards-removed.md`.

**When to revisit:** Optional *convergence* “discussion settled, save rounds”
signals (MoA/RR) are separate from wasteful-loop halts.

---

## Host bind defaults to loopback; API token optional (2026-07-09)

**Choice:** `SERVER_HOST` defaults to `127.0.0.1`. `SWARM_API_TOKEN` is optional
(empty = open API for a single trusted local operator). MCP process spawn from
start body / env is **off** unless `SWARM_ALLOW_MCP_SERVERS=true`.

**Why:** Trusted-appliance security posture for release 1.0 Phase 1. Binding
`0.0.0.0` without a token is still possible but logs a loud warning.

**When to revisit:** Multi-user LAN install or reverse-proxy front door —
require token by default when host is non-loopback.

**See:** `docs/RELEASE-1.0-PLAN.md`.

---

## Parallel `:cloud` prompts are not throttled in-app (2026-07-08)

**Choice:** When N agents use `:cloud` models in the same phase, all N may call
`promptWithRetry` → provider concurrently. There is **no** local admission
controller, slot queue, or “max 2 concurrent cloud” gate.

**Why:** A short-lived `cloudAdmission` layer caused false “waiting for model /
cloud slot” UI, delayed prompts that were never sent, and fought the preset
design (e.g. four independent council contract drafts). Production use showed
four parallel provider streams work; the throttle made the system feel worse,
not more reliable.

**Do not reintroduce without updating `docs/decisions.md`:** See decision
*“No client-side `:cloud` admission / concurrency throttling”* (2026-07-08).
Contributors and coding agents should not add admission pipes, semaphores on
`:cloud`, or widened stagger solely to “protect” the provider from parallel
fan-out.

**When overload is real:** Use `providerFailover`, retry/backoff in
`promptWithRetry`, lower `agentCount`, or provider-side limits — not hidden
in-process queuing that mislabels agent state.

---

## Hard stop may cap execution-worker wait at 45s (2026-07-08)

**Choice:** On hard stop during council execution, close-out waits up to **45 seconds**
for `runCouncilWorkers` to exit after abort before writing summary and calling `killAll`.

**Why:** Without a cap, a hung provider call could wedge `POST /stop` indefinitely. With
no wait at all, summary and “ports released” race ahead of in-flight workers (see run
`43e79fa7`).

**Ideal contract:** Documented in `docs/run-stop-drain-lifecycle.md`. After close-out,
no execution transcript lines should appear.

**When this would need revisiting:** If 45s proves too short for legitimate drain tails
or too long for interactive stop UX — tune the cap in `CouncilRunner.awaitLoopThenCloseOut`
and update the lifecycle doc in the same PR.

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

## Planner todos cap at two expectedFiles per item

**Choice:** Zod schema + `lenientPreprocess` allow at most **2** `expectedFiles` per planner todo (hunks variant). Models often emit four (new module + new component + registry + config).

**Mitigation (2026-07-07):** `prioritizeExpectedFilesSlice()` keeps registry/config paths when truncating, so grounding is less likely to drop every todo because invented `sources/` paths were listed first.

**Remaining gap:** New-file work still needs at least one grounded path; invented directory trees under absent parents are stripped by `groundExpectedFiles`. Planner prompt + contract should cite paths from the actual repo file list (e.g. existing `src/routes/` or `server/api/`), not invented deep trees.

---

## Agent web tools are opt-in only (2026-07-07)

**Default (no `webTools` / `plannerTools`):** Agents are sandboxed to the cloned
repository via the in-process `ToolDispatcher`:

- `swarm` (default workers): **no tools**. Must return clean JSON.
- `swarm-read` (planners, discussion roles, auditors): `read | grep | glob | list`.
- `swarm-builder` (build / test roles): above + restricted `bash` (allowlisted
  build/test commands only; no `curl`, cwd-bound).

**Opt-in research mode (`webTools: true` or `plannerTools: true`):**
`shared/src/toolProfiles.ts` upgrades profiles:

- `swarm-planner` — local tools + `web_search`, `web_fetch`
- `swarm-research` — same for workers / auditors / discussion readers
- `swarm-builder-research` — build profile + web tools

Blackboard runs a **research pre-pass** before JSON-locked contract turns.
Tool calls are logged to the transcript. Web fetch is biased toward
gov/academic sources; there is no general browser or arbitrary HTTP.

**Still not available:** GitHub MCP integration, Playwright
(`MCP_PLAYWRIGHT_ENABLED`), or unconstrained external APIs in the general
agent loop.

**See also:** `server/src/tools/ToolDispatcher.ts`, `researchPrePass.ts`,
`toolCallTranscript.ts`, README "Using for Scientific Research & Internet Work".

Live web access remains a deliberate opt-in with bounded tools — not the
default path for code-editing runs.

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
