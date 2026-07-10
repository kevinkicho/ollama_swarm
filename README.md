# ollama_swarm

> **For agents picking up this codebase**: read [`docs/STATUS.md`](docs/STATUS.md) first — it's the single "what's true right now" pointer + map (updated 2026-07-07). This README is the user-facing intro and the public face of the repo on GitHub.

> **Before pushing code**: read [`docs/CI-RELIABILITY.md`](docs/CI-RELIABILITY.md). It documents the exact process and tooling (`npm run verify-ci` + git hooks) that prevents the classic "worked locally, red on CI" cycle.

A local web app that runs **multiple concurrent swarms** of open-weights coding agents. A **Brain-as-OS layer** monitors runs, proposes self-improving changes, provisions new runs, and manages at the system level. Agents collaborate (via shared transcript or blackboard) on GitHub repos using different roles/models.

**Current focus (as of 2026-07):** Reliable Windows development experience, polished live UI (transcript + sidebar), Brain-as-OS features, and support for composite "pipeline" preset runs. Hybrid planning mode has been removed.

**Five providers** are wired in, surfaced as side-by-side tabs in the setup form:

- **Ollama (local)** — models served by your local [Ollama](https://ollama.com) install. Free, GPU-bound, no key.
- **Ollama Cloud** — `:cloud` / `-cloud` models hosted on ollama.com. Routes through your local Ollama install; set `OLLAMA_API_KEY` in `.env` for direct calls.
- **OpenCode Go** — [subscription-based](https://opencode.ai/docs/go/) curated open models (`opencode-go/deepseek-v4-pro`, `opencode-go/glm-5.1`, etc.). Set `OPENCODE_API_KEY` in `.env`. Falls back to Zen balance when limits reached.
- **[Anthropic Claude](https://www.anthropic.com)** — set `ANTHROPIC_API_KEY` to enable; live model discovery.
- **[OpenAI](https://openai.com)** — set `OPENAI_API_KEY` to enable; live model discovery.

Ollama Cloud is the default — `deepseek-v4-flash:cloud` ships pre-selected.

> **2026-04-29 — opencode subprocess fully removed (E3 Phases 1–5).** Earlier versions spawned an `opencode serve` HTTP subprocess per agent. That whole path is gone. Every prompt now runs through a direct provider abstraction (`pickProvider` → `chatOnce`); tool-using turns route through an in-process `ToolDispatcher` (read / grep / glob / list / bash with a hard allowlist). The opencode CLI is no longer a runtime dep. Some env vars (notably `OPENCODE_SERVER_PASSWORD`) are still required at config-load time so existing setups don't break, but they're otherwise unused.

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

**Expanded for full Brain-OS agent loops** (recommend → start → status → amend → stop):

```bash
# Get a data-driven recommendation with real numbers from past runs
ollama-swarm recommend --directive "analyze papers on superconductors and synthesize common features"

# Start (supports --json for agents)
ollama-swarm start --directive "..." --preset council --web-tools true

# Monitor / steer
ollama-swarm status --run-id <id>
ollama-swarm amend --run-id <id> --text "focus on crystal structure"
ollama-swarm stop --run-id <id>
```

See `bin/ollama-swarm.mjs --help`, `examples/brain-agent-loop.mjs`, and [`docs/BRAIN-OS-FOR-EXTERNAL-AGENTS.md`](docs/BRAIN-OS-FOR-EXTERNAL-AGENTS.md) for full details on using Brain as an OS from external agents/scripts.

The Brain chat (`/api/swarm/brain/chat`) now proactively uses the outcome recommender + stats and references the use-case tables from `docs/swarm-patterns.md` + `STATUS.md`. It can suggest UI filters and supports `?structured=true`.

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

**2. Live transcript + Brain.** Per-agent panels on the left show status (`spawning` → `ready` → `thinking` → `ready`). Each agent's reply streams in token-by-token; you can inject a `[HUMAN]` line into the shared transcript at any time. Transcript shows the full log by default ("all" entries: system, agents, synthesis, brain activity, pipeline steps, etc.). Agent bubbles strip think tags and pseudo-tool XML (including DeepSeek `<function>` blocks); expand **Thinking** to see prose plus a compact list of intended reads. Use the filter bar for "key" (high-signal only) or other subsets if desired. During active runs a persistent floating 🧠 **Brain** button (bottom-right) opens a chat modal with live run context (board + recent transcript summary). Brain suggestions can be proactively injected into the transcript. The topbar shows elapsed time, idle/active state, brain health, and a token-usage popover.

![Live transcript with five agents collaborating on a shared discussion](docs/images/transcript.png)

**3. Board (blackboard preset only).** Five-column kanban — **Open / Claimed / Committed / Stale / Skipped** — plus a Findings pane. Worker cards show which agent is holding them and how long; stale cards show the CAS rejection reason. A run-summary card pins to the top when the run terminates.

![Blackboard view with todos flowing through Open → Claimed → Committed → Stale → Skipped columns](docs/images/board.png)

## What it does

You fill in a GitHub URL, a local clone path, an agent count, and pick a **pattern**. The agents spawn, clone the repo, and start collaborating — each running an open-weights model on your local Ollama (or, optionally, Ollama Cloud / Anthropic / OpenAI). **12 presets** ship today (blackboard is primary production write-capable; council has full autonomous 3-phase cycles with self-improvement potential; others discussion or exploration with opt-in writes; baseline for comparison).

A **Brain-as-OS** layer provides analysis, cross-run memory, provisioning help, and during-run conversational assistance (persistent FAB + `/brain/chat`, `/brain/suggest`, history persistence). See `docs/STATUS.md` for current features including FAB Brain chat, proactive suggestion injection into transcripts, and per-run persistence.

See `docs/swarm-patterns.md` for the full pattern catalog. Research / internet-heavy usage (webTools + council or pipeline preset) is documented in the "Using for Scientific Research & Internet Work" section below and in STATUS.md.

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

### Using for Scientific Research & Internet Work

For research use cases (e.g., analyzing common properties of materials like superconductors, discovering data endpoints, literature synthesis):

- Enable `webTools: true` + `plannerTools: true` (gives planners `web_search` + `web_fetch` with gov/academic bias).
- Recommended: pure `council` (or `map-reduce`, `moa`, `role-diff`) for analysis, or the `pipeline` preset to chain presets (e.g. council exploration → blackboard execution). Hybrid mode has been removed.
- Use the "swarm-research" profile for broader tool access.
- See the full guidance in `docs/swarm-patterns.md` and STATUS.md for the preset matrix.

Web results are now returned in structured format (Title, URL, Snippet, RelevanceScore, source type) to help the planner synthesize findings reliably.

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
- **Pipeline preset**: chains sub-runs (e.g. council for analysis → blackboard for execution with auditor gates). Use for planning-then-execution workflows without dedicated hybrid mode.

- **Cost cap (paid providers)** — every run on Anthropic/OpenAI checks cumulative spend against `maxCostUsd` every 5 seconds; stops cleanly with `cap:cost` when the ceiling is reached. Ollama runs ignore the cap (every record costs $0).
- **Eval harness + scoreboard** — `node eval/run-eval.mjs --repo=<url> --seeds=5` runs every preset against the catalog, then `node eval/aggregate.mjs runs/_eval/<ts>` writes `eval/RESULTS.md` with median + IQR per cell. See [`eval/fixtures/README.md`](eval/fixtures/README.md) for the self-contained fixture pattern.
- **Infinite run tier progression** — the ambition ratchet now retries after tier promotion failure instead of stopping immediately (3-attempt cap). Degenerate contracts (e.g., "read the repo files") are filtered out before they waste worker cycles.
- **Auditor/planner transient error resilience** — network errors during auditor or planner fallback calls are caught and skipped instead of killing the entire run. The loop continues on the next cycle.
- **Design memory directive alignment** — the post-run design memory update now injects the user directive into the roadmap prompt, preventing drift toward generic platform features.
- **Model switch fallback removed** — `SIBLING_MODELS` map emptied; `withSiblingRetry` returns false immediately. Model switching for content issues (invalid JSON, empty response) was dead code — both models route through the same provider path and fail the same way. The real safety nets are stuck-cycle detection, planner fallback, and auditor re-fires.

**Current architecture includes a Brain-as-OS layer** on top of the V2 substrate. The original opencode-SDK path was retired (E3 2026-04-29). Runs use direct providers + in-process ToolDispatcher. Multiple swarms run concurrently. The Brain (monitoring + proposals + self-upgrader + provisioner) sits above the Orchestrator and manages system-level work + self-improvement. See `docs/STATUS.md` and `server/src/swarm/blackboard/brainOverseer/`.

### Agent tools (what workers / planners can actually do)

By default, agents have **no internet access**. Tools are local to the cloned repo via `ToolDispatcher`:

- **"swarm"** (default workers): no tools — pure structured JSON.
- **"swarm-read"** (planners, many roles): `read`, `grep`, `glob`, `list`.
- **"swarm-builder"** (build roles): the above + restricted `bash` (allowlisted build/test commands only).

**Opt-in research mode** (`webTools: true` or `plannerTools: true`): profiles upgrade to `swarm-planner`, `swarm-research`, or `swarm-builder-research`, adding `web_search` + `web_fetch`. Blackboard runs a research pre-pass before contract derivation; tool calls appear in the transcript. See `shared/src/toolProfiles.ts` and `docs/known-limitations.md`.

GitHub MCP and Playwright (`MCP_PLAYWRIGHT_ENABLED`) are not part of the general agent loop.

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

**E3 (2026-04-29) removed the per-agent `opencode serve` subprocess.** Earlier versions spawned one opencode HTTP server per agent on a random port and held an SDK client per agent; the SDK is now uninstalled and `Agent` no longer carries a `client` field. Every prompt goes through a direct provider call via `chatOnce` and (for tool-using turns) a local `ToolDispatcher` that implements read/grep/glob/list/bash with a hard allowlist. `PortAllocator` is gone.

See `docs/STATUS.md` for the current feature set and `docs/ARCHITECTURE-VISION.md` for the longer-term direction.

## License

See [LICENSE](LICENSE) (MIT).
