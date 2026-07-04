# ollama_swarm

> **For agents picking up this codebase**: read [`docs/STATUS.md`](docs/STATUS.md) first — it's the single "what's true right now" pointer + map. This README is the user-facing intro.

A local web app that runs **multiple concurrent swarms** of open-weights coding agents. A **Brain-as-OS layer** monitors runs, proposes self-upgrading patches to the system itself, provisions new runs, and manages at the system level. Agents collaborate (via shared transcript or blackboard) on GitHub repos using different roles/models. The goal is autonomous, self-improving multi-agent orchestration on local hardware.

**Five providers** are wired in, surfaced as side-by-side tabs in the setup form:

- **Ollama (local)** — models served by your local [Ollama](https://ollama.com) install. Free, GPU-bound, no key.
- **Ollama Cloud** — `:cloud` / `-cloud` models hosted on ollama.com. Routes through your local Ollama install; set `OLLAMA_API_KEY` in `.env` for direct calls.
- **OpenCode Go** — [subscription-based](https://opencode.ai/docs/go/) curated open models (`opencode-go/deepseek-v4-pro`, `opencode-go/glm-5.1`, etc.). Set `OPENCODE_API_KEY` in `.env`. Falls back to Zen balance when limits reached.
- **[Anthropic Claude](https://www.anthropic.com)** — set `ANTHROPIC_API_KEY` to enable; live model discovery.
- **[OpenAI](https://openai.com)** — set `OPENAI_API_KEY` to enable; live model discovery.

Ollama Cloud is the default — `deepseek-v4-flash:cloud` ships pre-selected.

> **2026-04-29 — opencode subprocess fully removed (E3 Phases 1–5).** Earlier
> versions spawned an `opencode serve` HTTP subprocess per agent. That whole
> path is gone. Every prompt now runs through a direct provider abstraction
> (`pickProvider` → `chatOnce`); tool-using turns route through an in-process
> `ToolDispatcher` (read / grep / glob / list / bash with a hard allowlist).
> The opencode CLI is no longer a runtime dep. Some env vars (notably
> `OPENCODE_SERVER_PASSWORD`) are still required at config-load time so
> existing setups don't break, but they're otherwise unused.

## Quickstart

```bash
# 1. Clone + install (run npm install from a Windows/macOS/Linux shell —
#    NOT from WSL if your repo lives under /mnt/c, see Troubleshooting)
git clone https://github.com/kevinkicho/ollama_swarm.git
cd ollama_swarm
npm install

# 2. Configure secrets
cp .env.example .env
# Edit .env — set OPENCODE_SERVER_PASSWORD to any non-empty string (still
# required at config-load time post-E3, otherwise unused). Optional keys:
# ANTHROPIC_API_KEY / OPENAI_API_KEY for paid providers; OLLAMA_API_KEY
# for direct Ollama Cloud calls (otherwise the local install proxies
# :cloud models when you have an ollama.com account configured locally).

# 3. Pull the default Ollama model (skip if you'll only use paid providers)
ollama pull deepseek-v4-flash:cloud
# Optional second signal for the drift gauge:
ollama pull nomic-embed-text

# 4. Start the dev stack (backend on :8243, web UI on :8244)
npm run dev
```

Then open **http://localhost:8244/** (or the WSL guest IP if you're hitting it from Windows — `ip addr show eth0` for the address). Fill in the form, hit **Start swarm**, watch agents stream into the transcript live.

> **Heads-up:** `npm run start` runs *only* the backend (Express + WS at `:8243`); it does **not** serve the SPA. Use `npm run dev` for local use. If you previously ran with the older default ports (52243 / 52244), those moved on 2026-04-27 to dodge Windows' Hyper-V reserved range — new defaults are 8243 / 8244.

## CLI (for agents / Brain / terminal)

The project now ships a real `ollama-swarm` CLI so that Brain (or any agent) can start runs by running a command instead of just printing instructions.

```bash
# After you have the server running (npm run dev)
ollama-swarm start --config swarm_config.json

# Or pass everything on the command line (great for LLMs/agents)
ollama-swarm start \
  --parent-path "C:\Users\you\workspace\my-project" \
  --directive "add more data panels using gov endpoints..." \
  --preset blackboard \
  --agent-count 5 \
  --rounds 0 \
  --model deepseek-v4-flash:cloud

# Dry run (see exactly what would be sent)
ollama-swarm start --parent-path "..." --directive "..." --dry-run
```

The CLI talks to the running server at http://localhost:8243 (override with `--server` or `OLLAMA_SWARM_SERVER_URL`).

You can also do `npm run cli start -- --help`.


## Tour

**1. Setup form.** Pick a repo, a parent folder to clone into, an agent count, and one of the **12 presets** (blackboard + discussion/pipeline variants + baseline). The optional User Directive seeds the conformance gauge and is honored by every preset except `stigmergy`. The AI Provider section is a **5-tab** segmented control (Ollama / Ollama Cloud / OpenCode / Anthropic / OpenAI) with a model dropdown that filters per-provider. Council and Blackboard presets support autonomous mode (`rounds: 0`) for infinite improvement loops.

![Setup form — GitHub URL, parent folder, pattern picker, agents/rounds/model fields](docs/images/setup-form.png)

**2. Live transcript.** Per-agent panels on the left show status (`spawning` → `ready` → `thinking` → `ready`). Each agent's reply streams in token-by-token; you can inject a `[HUMAN]` line into the shared transcript at any time. The topbar shows elapsed time, idle/active state, and a token-usage popover.

![Live transcript with five agents collaborating on a shared discussion](docs/images/transcript.png)

**3. Board (blackboard preset only).** Five-column kanban — **Open / Claimed / Committed / Stale / Skipped** — plus a Findings pane. Worker cards show which agent is holding them and how long; stale cards show the CAS rejection reason. A run-summary card pins to the top when the run terminates.

![Blackboard view with todos flowing through Open → Claimed → Committed → Stale → Skipped columns](docs/images/board.png)

## What it does

You fill in a GitHub URL, a local clone path, an agent count, and pick a **pattern**. The agents spawn, clone the repo, and start collaborating — each running an open-weights model on your local Ollama (or, optionally, Ollama Cloud / Anthropic / OpenAI). **12 presets** ship today (blackboard is primary production write-capable; council has full autonomous 3-phase cycles with self-improvement potential; others discussion or exploration with opt-in writes; baseline for comparison):

- **Round-robin transcript** — N agents take turns on a shared transcript; each turn rotates through Critic / Synthesizer / Gap-finder / Builder dispositions, with the lead synthesizing a directive answer at the end. Discussion-only.
- **Blackboard (optimistic + small units)** — planner posts atomic todos to a shared board; workers claim and commit in parallel, with CAS on file hashes catching stale plans. **The only write-capable preset** — workers actually modify the clone.
- **Role differentiation** — with a directive, becomes a build team (Researcher / Designer / Implementer / Tester / Reviewer / Documenter / Devil's-advocate) producing `deliverable.md`. Without one, falls back to a 7-lens repo audit. Discussion-only.
- **Map-reduce** — reducer + N mappers slicing the repo in parallel. With a directive, mappers find directive-relevant evidence in their slice and reducer synthesizes the answer. Convergence detector stops on consecutive empty cycles. Discussion-only.
- **Council** — N drafters debate and synthesize a consensus (Phase 1: Analysis). Then ALL agents become workers and execute the consensus (Phase 2: Execution). Finally ALL agents become auditors and inspect the results (Phase 3: Audit). In autonomous mode (`rounds: 0`), cycles repeat: analysis → execution → audit → analysis. Supports infinite improvement loops. Now uses blackboard's infrastructure: TodoQueue, ExitContract, hunk-based editing, replanner, path grounding, and tier ratchet.
- **Orchestrator–worker** — lead decomposes the directive into worker subtasks; workers report directive-relevant findings; lead synthesizes. Discussion-only.
- **Orchestrator–worker (deep)** — 3-tier variant for ≥4 agents: orchestrator → mid-leads → workers. Synthesis flows back upward. Discussion-only.
- **Debate-judge** — Pro / Con / Judge (exactly 3 agents). Judge auto-derives a debatable proposition from your directive. Optional post-verdict build phase turns Pro into implementer. Discussion-by-default; `executeNextAction: true` enables file edits.
- **Stigmergy** — pheromone-table + per-file ranking pattern. Self-organizing exploration; agents pick the next file based on a shared annotation table. Discussion-only. (Doesn't honor the user directive — exploration is repo-driven.)
- **Mixture of Agents (MoA)** — N proposers each draft independently (peer-hidden, parallel); one aggregator synthesizes their drafts. Reproducibly beats single-large-model on reasoning benchmarks using only small open-weights models. Discussion-only.
- **Baseline** — single agent, single prompt, single apply step. The "thinnest honest comparison" the eval scoreboard uses to anchor "did the swarm beat doing it alone?" Code-modify capable; not surfaced in the form's normal preset list (eval-harness path).
- **Pipeline** — chains sub-runs (e.g. explore → decompose → validate).

**Beyond single runs:** A **Brain-as-OS layer** monitors activity, generates self-improvement proposals, applies patches via self-upgrader, and provisions runs. Multiple swarms run concurrently (Active Runs panel + `/runs/:runId`). A live transcript streams into the browser as it's generated — you see each agent type token-by-token, can inject your own message into the conversation at any time, and stop the whole thing with one click. The blackboard preset adds a **Board** tab showing todos in five columns (Open / Claimed / Committed / Stale / Skipped), plus a run summary card when the run terminates.

### Current system-level capabilities + observability
- **Brain-as-OS** — monitoring, proposal generation from run patterns, self-upgrading patches, run provisioning.
- **Concurrent swarms** — run multiple at once; manage via Active Runs UI and per-run deep links.
- **System UI wrapper** — persistent sidebar, brain panels, health, patch monitor, cross-run metrics.

### Observability + reliability features

- **Conformance gauge** — during runs with a User Directive, a live LLM-as-judge polls the transcript every 90s and renders a colored sparkline + numeric score (0–100) in the topbar showing how on-topic the run stays. Hover for the smoothing-window math + grader metadata.
- **Embedding-similarity drift** — independent second signal alongside the LLM-judge. Pull `nomic-embed-text` to enable; the tooltip shows agreement vs disagreement between the two signals.
- **Mid-run nudge** — submit a directive amendment without restarting; the planner picks it up at the next cycle.
- **Cost-share breakdown** — per-agent token shares + savings hint when one role dominates with a coding-tier-suitable model.
- **Pre-commit verify gate (blackboard)** — set `verifyCommand` (e.g. `npm test`) to gate worker hunks; failures revert the writes and mark the todo for replan.
- **Auditor-controlled mutations** (new): `auditorOnlyMutations: true` + `requireAuditorVerification` (blackboard only). Workers only propose hunks (pending-commit). The auditor:
  - Runs a dedicated "hunk review" prompt on the exact proposed changes.
  - Collects **all** approved changes in memory (using pure `applyHunks`).
  - Writes final state once.
  - Runs verify **once** (if required).
  - Creates **one single git commit** for the whole batch.
  This is the recommended high-safety mode — the auditor is the only entity that mutates the repo. Exposed in the web form under Blackboard advanced settings.
- **Hybrid planning (council → blackboard etc.)**: `useHybridPlanning: true`, `planningPreset: "council"`, `executionPreset: "blackboard"`, `webTools: true`. Planning phase (debate/synthesis) builds broad understanding + deliverable; results are automatically piped as `userDirective` + transcript snippets into the blackboard execution phase. Blackboard planner additionally receives a lightweight `systemMap` (top-level dirs + sample files + README excerpt) for cross-cutting reasoning without violating its read caps. `webTools` gives the planner `web_search` + `web_fetch` (MCP-style external tools). Gives "god-mode discreetly" in planning while keeping blackboard's robust gated execution + batch auditor commit intact. Toggle + dropdowns (including web research) live in the Topology card → "🧭 Planning Phase".

**Example hybrid config** (via form under blackboard advanced, or direct POST to /api/swarm/start, or Brain chat):

```json
{
  "preset": "blackboard",
  "useHybridPlanning": true,
  "planningPreset": "council",
  "executionPreset": "blackboard",
  "webTools": true,
  "userDirective": "please use existing data endpoints and governmental & non-governmental data endpoints (find through websearch) to put down more panels...",
  "auditorOnlyMutations": true,
  "requireAuditorVerification": true,
  "verifyCommand": "npm test"
}
```

Expected transcript flow (simplified):
- [Pipeline] Starting phase 1/2: council ...
- (Council debate/synthesis produces broad plan + deliverable with systemic insights)
- [Pipeline] Starting phase 2/2: blackboard ...
- Piped: ## Prior Phase Output (deliverable) + transcript snippets injected as directive/context.
- Planner uses the rich piped context + systemMap for grounded TODOs.
- Workers propose (pending-commit).
- Auditor: explicit reviewProposedHunks + batch.
- [auditor-gate] Batching N approved changes...
- In-memory applyHunks → one commit: auditor batch approval (one commit): ...
- Final summary/deliverable with "hybrid" notes.

- **Cost cap (paid providers)** — every run on Anthropic/OpenAI checks cumulative spend against `maxCostUsd` every 5 seconds; stops cleanly with `cap:cost` when the ceiling is reached. Ollama runs ignore the cap (every record costs $0).
- **Eval harness + scoreboard** — `node eval/run-eval.mjs --repo=<url> --seeds=5` runs every preset against the catalog, then `node eval/aggregate.mjs runs/_eval/<ts>` writes `eval/RESULTS.md` with median + IQR per cell. See [`eval/fixtures/README.md`](eval/fixtures/README.md) for the self-contained fixture pattern.
- **Infinite run tier progression** — the ambition ratchet now retries after tier promotion failure instead of stopping immediately (3-attempt cap). Degenerate contracts (e.g., "read the repo files") are filtered out before they waste worker cycles.
- **Auditor/planner transient error resilience** — network errors during auditor or planner fallback calls are caught and skipped instead of killing the entire run. The loop continues on the next cycle.
- **Design memory directive alignment** — the post-run design memory update now injects the user directive into the roadmap prompt, preventing drift toward generic platform features.
- **Model switch fallback removed** — `SIBLING_MODELS` map emptied; `withSiblingRetry` returns false immediately. Model switching for content issues (invalid JSON, empty response) was dead code — both models route through the same provider path and fail the same way. The real safety nets are stuck-cycle detection, planner fallback, and auditor re-fires.

**Current architecture includes a Brain-as-OS layer** on top of the V2 substrate. The original opencode-SDK path was retired (E3 2026-04-29). Runs use direct providers + in-process ToolDispatcher. Multiple swarms run concurrently. The Brain (monitoring + proposals + self-upgrader + provisioner) sits above the Orchestrator and manages system-level work + self-improvement. See `docs/STATUS.md` and `server/src/swarm/blackboard/brainOverseer/`.

### Agent tools (what workers / planners can actually do)

Agents do **not** have general internet access. The only tools exposed via `ToolDispatcher` are local to the cloned repo:

- **Default ("swarm")**: no tools — workers return pure structured JSON.
- **"swarm-read"** (planners, many roles): `read`, `grep`, `glob`, `list` (files inside the clone only). Planners are often limited to a small number of reads per turn.
- **"swarm-builder"** (selected build roles): the above + a **very restricted** `bash` (only allowlisted build/test commands like `npm test`, `tsc --noEmit`; no `curl`, no arbitrary net, cwd-bound).

There are **no** `web_search`, `browse_page`, HTTP fetch, or external tooling tools for agents. GitHub MCP definitions exist under `mcps/` and Playwright is opt-in for the auditor (`MCP_PLAYWRIGHT_ENABLED`), but they are not part of the general agent loop.

When `webTools: true` (and plannerTools), the planner gets `web_search` + `web_fetch`. Otherwise, the model answers from training data only.

See `server/src/tools/ToolDispatcher.ts`, `promptWithRetry.ts`, and `docs/known-limitations.md`.

## Architecture

```
Browser (React + Vite + Zustand + Tailwind)
   │   WebSocket /ws      REST /api/*
   ▼
Node server (Express + ws)
   ├── RepoService     git-clone target repo
   ├── pickProvider    factory returning OllamaProvider | OllamaCloudProvider | OpenCodeProvider | AnthropicProvider | OpenAIProvider
   ├── AgentManager    in-process Agent records (id, index, model, cwd) — no subprocess
   ├── ToolDispatcher  in-process read / grep / glob / list / bash for tool-using turns
   └── Orchestrator    shared-transcript message bus; round-robin turn loop gated
                       on SSE-aware liveness watchdog (not wall-clock)
      │
       └── chatOnce(agent, prompt) → SessionProvider.chat()
               ├─ Ollama      : POST localhost:11434/api/chat   (default)
               ├─ Ollama Cloud: POST ollama.com/api/chat   (:cloud models)
               ├─ OpenCode Go : POST opencode.ai/zen/go/v1/chat/completions   (subscription)
               ├─ Anthropic   : POST api.anthropic.com/v1/messages   (tool_use loop)
               └─ OpenAI      : POST api.openai.com/v1/chat/completions   (tool_calls loop)
```

**E3 (2026-04-29) removed the per-agent `opencode serve` subprocess.** Earlier
versions spawned one opencode HTTP server per agent on a random port and held
an SDK client per agent; the SDK is now uninstalled and `Agent` no longer
carries a `client` field. Every prompt goes through a direct provider call
via `chatOnce` and (for tool-using turns) a local `ToolDispatcher` that
implements read/grep/glob/list/bash with a hard allowlist. `PortAllocator`
and the historical port-4096 plumbing are gone with the subprocess.

### How the round-robin preset works

1. **Seed** — a system message drops the clone path, repo URL, and top-level file listing into the shared transcript, and instructs agents to use their tool dispatcher (read / grep / glob / list) to inspect the repo.
2. **Round-robin turn loop** — for `rounds` iterations, each agent in turn receives a prompt containing the **entire transcript so far** plus role instructions ("you are Agent N, respond in under 250 words, cite file paths"). The agent uses its tool dispatcher to read files and produces a reply.
3. **SSE-aware idle watchdog** (commit `189ca05`) — we don't use a fixed wall-clock turn timeout. The provider streams partial chunks; the runner consults `AgentManager.getLastActivity()` and aborts a turn only if no chunk has arrived for 90 seconds, with a 30-minute hard ceiling as a safety net. Long-tail latency that's still producing tokens isn't killed.
4. **Live streaming to the UI** — partial-chunk events forward to the browser as `agent_streaming` WebSocket messages; you see a pulsing "typing" bubble that fills in as tokens arrive. On turn completion the streaming bubble is replaced by the final transcript entry.
5. **User injection** — the input at the bottom of the transcript view lets you post a `[HUMAN] ...` line into the shared transcript at any time; every agent sees it on their next turn.
6. **Stop / New swarm** — Stop aborts all in-flight turns; the UI then shows a "New swarm" button that returns you to the setup form.

### How the blackboard preset works

A phase-by-phase journal is archived at [`docs/archive/blackboard-changelog.md`](docs/archive/blackboard-changelog.md); the architecture-as-shipped lives at [`server/src/swarm/blackboard/ARCHITECTURE.md`](server/src/swarm/blackboard/ARCHITECTURE.md). The short version:

1. **Planner vs. workers.** Agent 0 is the planner and only posts todos; agents 1..N−1 are workers and only claim + commit. Planner prompts and worker prompts are different loops against the same model. Tool use stays off for workers — they return structured JSON diffs that the Node runner writes to disk, which keeps CAS server-authoritative.
2. **Atomic todos.** Each todo names ≤2 `expectedFiles` and one logical change. Small units keep the conflict surface tiny and make stale replans cheap.
3. **Optimistic CAS on file hashes.** At claim time the board records a SHA of every file the worker plans to touch. At commit time the runner re-hashes and rejects the commit if any hash changed underneath the worker (another worker committed first). No locks, no head-of-line blocking.
4. **Stale → replan.** A rejected commit marks the todo `stale` with a reason. The planner re-reads the current code and rewrites the todo; the card shows an `R1` / `R2` badge counting replans. Workers see the fresh description on the next claim.
5. **Hard caps.** Every run is bounded by configurable wall-clock (default **8 hours**, env-tunable to **7 days**), **10,000 commits**, and **10,000 todos** (see `server/src/swarm/blackboard/caps.ts`). The loop stops on whichever fires first with a `cap:wall-clock` / `cap:commits` / `cap:todos` stop reason. In autonomous mode (`rounds: 0`), the ambition ratchet has unlimited tiers.
6. **Run artifact.** On any termination (`completed`, user `stop`, `crash`, or a cap), the runner writes `summary.json` at the clone root with `stopReason`, `wallClockMs`, commit/file counts, per-agent turn stats, and the final `git status --porcelain`. A summary card with the same data renders at the top of the Board tab.
7. **Board tab.** The UI's Board tab shows todos in five columns — **Open** / **Claimed** / **Committed** / **Stale** / **Skipped** — and a collapsible Findings pane. Claim cards show which worker is holding them and how long; stale cards show the rejection reason.

## Prerequisites

- **Node 22 LTS or 25** (CI runs 22.x; local dev tested on both)
- **[Ollama](https://ollama.com) running** at `http://localhost:11434` with at least one model pulled. Default is `deepseek-v4-flash:cloud`:
  ```bash
  ollama pull deepseek-v4-flash:cloud
  ```
  Optional but recommended: `ollama pull nomic-embed-text` to enable the embedding-similarity drift gauge alongside the LLM-judge conformance gauge.
- **git** on `PATH`. (No need to set `user.name` / `user.email` globally — the worker pipeline injects them inline per-commit.)
- (Optional) **`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`** in `.env` if you want to run against Claude or GPT instead of Ollama.

## Usage walkthrough

1. **GitHub URL** — a public repo URL, or a private one if `GITHUB_TOKEN` is set in `.env` (the token is spliced into the clone URL).
2. **Parent folder** — an absolute path to a _parent_ directory. The server derives the repo name from the URL and clones into `<parentFolder>/<repo-name>` (e.g. parent `C:\...\runs` + URL ending in `/is-odd` → clone at `C:\...\runs\is-odd`). Parent is created if missing; the subfolder must be empty, absent, or already a matching git clone. The form shows a live preview of the resolved clone path under the field.
3. **Pattern** — choose from 12 presets. Blackboard is the primary write-capable production preset. Council supports full autonomous 3-phase cycles. See STATUS.md for the current matrix.
4. **Agents** — how many concurrent agents to spawn (2–8 for most presets). On blackboard, agent 1 is the planner and the remaining N−1 are workers. `debate-judge` requires exactly 3; `map-reduce` and `orchestrator-worker-deep` require ≥4.
5. **Rounds** — for discussion presets: how many full passes through the agents. For blackboard: the maximum number of **auditor invocations** (plan → work → audit cycles) before the run stops even if unresolved criteria remain. Blackboard still stops earlier on the hard caps (per-run `wallClockCapMs` defaults to **8 hours** if not set, plus baked-in 200-commits / 300-todos backstops) or when every criterion is resolved. The cap is enforced by a 5s-tick watchdog (`#305`), so runs stop within ~5 seconds of the threshold rather than waiting for the next phase boundary. With non-blackboard presets, high values can mean hours of wall-clock and proportional cloud-token spend.
6. **Model** — any model string the active provider can serve. For Ollama, this must be a model the local install can run (`ollama list`); the form's autocomplete reads `/api/models` for matches. For paid providers, prefix with the provider name: `anthropic/claude-opus-4-7`, `openai/gpt-5`, `opencode-go/deepseek-v4-pro`, etc. **Settings history** saves configurations across sessions for one-click reuse.

Hit Start. You'll see each agent panel go from `spawning` → `ready` → `thinking` → `ready`, with live streaming bubbles in the transcript as each agent works. On blackboard runs, switch to the **Board** tab to watch todos flow through Open → Claimed → Committed (or Stale → back to Open on CAS rejection). When the run terminates the phase pill flips to `completed` / `stopped` / `failed` and a summary card appears at the top of the Board tab; a **New swarm** button is available in the sidebar.

Hit the **+ nudge** button next to the conformance gauge to submit a mid-run directive amendment when you spot drift. The drift gauge appears next to it if `nomic-embed-text` is installed.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENCODE_SERVER_PASSWORD` | no (defaults to `test-only`) | Historical opencode HTTP-basic-auth secret. The opencode subprocess is gone (E3 Phase 5). `config.ts` defaults this to `test-only` when unset so local dev works without a `.env`; set any non-empty string in `.env` for explicit configuration. Production runs ignore the value. |
| `OLLAMA_BASE_URL` | no (defaults to `http://localhost:11434/v1`) | Ollama base URL. The provider stack normalizes a trailing `/v1` defensively (so legacy values still work). |
| `OLLAMA_API_KEY` | no (Ollama Cloud is always usable; key is informational) | Per [docs.ollama.com/cloud](https://docs.ollama.com/cloud). The Ollama Cloud tab is always selectable — the local Ollama install proxies `:cloud` models to ollama.com when an account is configured locally. Setting this key surfaces a "live key configured" hint in the tab tooltip. |
| `ANTHROPIC_API_KEY` | no (only when using Anthropic provider) | Read by the in-process `AnthropicProvider` via `process.env`. The setup form's Anthropic tab is disabled when unset. |
| `OPENAI_API_KEY` | no (only when using OpenAI provider) | Same pattern as `ANTHROPIC_API_KEY`. |
| `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY` | no (only when using OpenCode provider) | OpenCode Go subscription key or Zen balance key. `OPENCODE_API_KEY` works for both. Get yours at [opencode.ai/auth](https://opencode.ai/auth). |
| `DEFAULT_MODEL` | no (defaults to `deepseek-v4-flash:cloud`) | Model each agent uses when the form's model field is left blank. For paid providers use the prefixed form: `anthropic/claude-opus-4-7`, `openai/gpt-5`, etc. |
| `SERVER_PORT` | no (defaults to `8243`) | Override the backend HTTP+WS port |
| `WEB_PORT` | no (defaults to `8244`) | Override the Vite dev-server port |
| `GITHUB_TOKEN` | no | GitHub PAT for cloning private repos |
| `CONFORMANCE_MONITOR` | no (defaults on) | Set to `off` to skip the LLM-judge conformance gauge for runs with a directive |

## Project structure

Three npm workspaces:

- **`server/`** — Express + ws + `simple-git` + zod + `undici` (raw HTTP to provider APIs). Hosts the runners, the AgentManager, the proxy, the ToolDispatcher, and the REST + WS routes.
- **`web/`** — Vite + React + Zustand + Tailwind. Setup form, transcript, board, run-history modal.
- **`shared/`** — pure types + parsers consumed by both sides (state machine reducer, JSON extractors, summary formatter).

**Target project structure:** When you clone a repo and run the swarm against it, the following structure is created inside the clone:
- **`logs/<run-id>/summary.json`** + `logs/<run-id>/summary-<run-id>-<timestamp>.json` — run summaries (stop reason, commits, agent stats)
- **`logs/<run-id>/deliverable/`** — deliverable markdown files (filenames include preset name, e.g., `deliverable-council-<run-id>-<timestamp>.md`)
- **`logs/<run-id>/next-actions/`** — next-actions JSON files (filenames include preset name, e.g., `next-actions-council-<run-id>-<timestamp>.json`)
- **`.swarm-memory.jsonl`** — lessons learned across runs (blackboard preset)
- **`.swarm-design/`** — design memory (north-star, decisions, roadmap)

Each run gets its own folder under `logs/` to keep files organized. Filenames already include the preset name (e.g., `deliverable-council-...`, `deliverable-blackboard-...`) so no need to organize by preset. All files in the `logs/` folder are gitignored by default.

For the current per-file map (with V2 substrate files, route mounts, and per-component layout) see the **Where things live** section in [`docs/STATUS.md`](docs/STATUS.md). For per-function detail, the code is the source of truth — open the file.

## Limitations

See [`docs/known-limitations.md`](docs/known-limitations.md) for the full list with rationale + resolution status. Headline items today:

- **All discussion presets have opt-in write capability** (`cfg.writeMode: "single"` / `"multi"`). Blackboard has native writes. Only `stigmergy` remains read-only.
- **Worker hunks are search/replace, not patches.** Aider-style `{op: "replace", file, search, replace}` envelope. Falls back closed when the search anchor isn't unique.
- **Concurrent runs supported.** Multiple swarms can run in parallel (default cap via `SWARM_MAX_CONCURRENT_RUNS`). Use the Active Runs panel and `/runs/:runId` deep links. Old global single-run assumption has been replaced by per-run isolation.
- **In-memory transcript** — restarting the server loses live history. Per-run `summary.json` + per-event `logs/current.jsonl` are durable; the run-history dropdown reads the former.
- **Localhost assumed.** No auth on the web app itself. Docker deployment available (`docker-compose up`).
- **`/mnt/c` (WSL) flakiness.** tsx watch occasionally SIGTERMs the dev server when files in `/mnt/c` change rapidly; restart the dev server when this happens. Does not affect production. Don't `npm install` from WSL on a `/mnt/c` repo — it swaps esbuild's binary for Linux and breaks the next Windows-side dev server.

## Troubleshooting

- **`OPENCODE_SERVER_PASSWORD is required in .env`** — you haven't copied `.env.example` to `.env` or haven't set the password. Set it to any non-empty string; nothing reads its value post-E3.
- **Startup log says `orchestrator opencode: http://127.0.0.1:4096`** — you're running a stale `dist/` from before E3 Phase 5. Rebuild: `npm -w server run build`. The current source no longer prints that line and no longer connects to port 4096.
- **`http://localhost:8243/` shows nothing** — that's the backend port. The web UI is on **`http://localhost:8244/`** (Vite). Use `npm run dev` to start both.
- **Empty agent responses across multiple presets** — usually Ollama isn't running, the model isn't pulled, or `OLLAMA_BASE_URL` is missing the `/v1` suffix. The proxy now defensively appends `/v1` (commit `bb0c509`), but check `curl http://localhost:11434/api/tags` first.
- **Port conflicts** — defaults are `SERVER_PORT=8243` / `WEB_PORT=8244`. If something else is bound, set either env var to a free port and restart. On Windows, check `netsh int ipv4 show excludedportrange protocol=tcp` if you get `EACCES` — Windows reserves chunks of ports for Hyper-V.
- **`turn silent for Ns` errors** — the SSE-aware watchdog (commit `189ca05`) aborts on 90s SSE silence OR a 30-min hard ceiling. Long-tail latency that's still producing tokens isn't killed. The swarm will continue on the next agent; check the `[agent-N]` lines in the backend terminal for the underlying provider error.

## License

MIT — see [`LICENSE`](LICENSE).
