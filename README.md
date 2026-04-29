# ollama_swarm

> **For agents picking up this codebase**: read [`docs/STATUS.md`](docs/STATUS.md) first — it's the single "what's true right now" pointer + map. This README is the user-facing intro.

A local web app that spawns a **swarm of [OpenCode](https://opencode.ai) agents** — each backed by an [Ollama](https://ollama.com) model such as `glm-5.1:cloud` — to clone a GitHub repository and collaboratively figure out what the project is, what's working, what's missing, and what to build next.

You fill in a GitHub URL, a local clone path, an agent count, and pick a **pattern**. **Nine patterns** ship today:

- **Round-robin transcript** — N identical agents take turns on a shared transcript; every agent sees every other agent's reply and responds. Discussion-only.
- **Blackboard (optimistic + small units)** — planner posts atomic todos to a shared board; workers claim and commit in parallel, with CAS on file hashes catching stale plans. **The only write-capable preset** — workers actually modify the clone.
- **Role differentiation** — round-robin loop with each agent given a distinct role (Architect, Tester, Security reviewer, etc.). Discussion-only.
- **Council** — N drafters write in private round 1, then read peers' drafts in subsequent rounds and converge. Has early-stop convergence detection. Discussion-only.
- **Orchestrator-worker** — agent-1 is the lead and dispatches subtasks; agents 2..N execute in parallel. Discussion-only.
- **Orchestrator-worker (deep)** — 3-tier variant for ≥4 agents: orchestrator → mid-leads → workers. Discussion-only.
- **Debate-judge** — Pro / Con / Judge (exactly 3 agents). Multi-round structured debate ending in a JSON verdict. Optional post-verdict "build phase" turns Pro into implementer. Discussion-by-default; `executeNextAction: true` enables file edits.
- **Map-reduce** — agent-1 is reducer, agents 2..N are mappers slicing the repo and summarizing in parallel. Convergence detector stops on consecutive empty cycles. Discussion-only.
- **Stigmergy** — pheromone-table + per-file ranking pattern. Self-organizing exploration; agents pick the next file based on a shared annotation table. Discussion-only.

A live transcript streams into the browser as it's generated — you see each agent type token-by-token, can inject your own message into the conversation at any time, and stop the whole thing with one click. The blackboard preset adds a **Board** tab showing todos in five columns (Open / Claimed / Committed / Stale / Skipped), plus a run summary card when the run terminates.

### Recent observability + reliability features

- **Conformance gauge** — during runs with a User Directive, a live LLM-as-judge polls the transcript every 90s and renders a colored sparkline + numeric score (0–100) in the topbar showing how on-topic the run stays. Hover for the smoothing-window math + grader metadata.
- **Embedding-similarity drift** — independent second signal alongside the LLM-judge. Pull `nomic-embed-text` to enable; the tooltip shows agreement vs disagreement between the two signals.
- **Mid-run nudge** — submit a directive amendment without restarting; the planner picks it up at the next cycle.
- **Cost-share breakdown** — per-agent token shares + savings hint when one role dominates with a coding-tier-suitable model.
- **Pre-commit verify gate (blackboard)** — set `verifyCommand` (e.g. `npm test`) to gate worker hunks; failures revert the writes and mark the todo for replan.
- **Eval harness** — `node eval/run-eval.mjs --repo=<url>` runs every preset against a curated catalog and writes a preset×task scoreboard.

**Current architecture is V2 substrate** — the original opencode-SDK-streaming path was retired 2026-04-28; runs go through `OllamaClient` (direct `/api/chat`) + `WorkerPipelineV2` + `TodoQueue` + `RunStateObserver` + `EventLogReaderV2`. See [`server/src/swarm/blackboard/ARCHITECTURE.md`](server/src/swarm/blackboard/ARCHITECTURE.md) for the deep dive.

## Architecture

```
Browser (React + Vite + Zustand + Tailwind)
   │   WebSocket /ws      REST /api/*
   ▼
Node server (Express + ws + @opencode-ai/sdk)
   ├── RepoService     git-clone target repo, drop opencode.json at clone root
   ├── PortAllocator   reserve free high TCP ports for spawned opencode servers
   ├── AgentManager    spawn `opencode serve --port N` per agent, one SDK client each,
   │                   subscribe to each agent's SSE event stream
   └── Orchestrator    shared-transcript message bus; round-robin turn loop gated
                       on SSE event activity (not wall-clock)
      │
      └── agent-1 opencode serve :random   → Ollama http://localhost:11434/v1
          agent-2 opencode serve :random   → Ollama http://localhost:11434/v1
          agent-N opencode serve :random   → Ollama http://localhost:11434/v1
```

Each agent gets its own `opencode serve` subprocess on a random free port (per [ADR 001](docs/decisions/001-per-agent-subprocess.md) — intentional isolation). There is no fixed "orchestrator opencode" requirement; the historical port-4096 plumbing in code is vestigial.

### How the round-robin preset works

1. **Seed** — a system message drops the clone path, repo URL, and top-level file listing into the shared transcript, and instructs agents to use their own file-read / grep / find tools to inspect the repo.
2. **Round-robin turn loop** — for `rounds` iterations, each agent in turn receives a prompt containing the **entire transcript so far** plus role instructions ("you are Agent N, respond in under 250 words, cite file paths"). The agent uses OpenCode tools to read files and produces a reply.
3. **SSE-aware idle watchdog** (commit `189ca05`) — we don't use a fixed wall-clock turn timeout. Each agent's opencode server pushes SSE events (`message.part.updated`, `session.idle`, `session.error`, etc.); the runner consults `AgentManager.getLastActivity()` and aborts a turn only if no SSE chunk has arrived for 90 seconds, with a 30-minute hard ceiling as a safety net. Long-tail latency that's still producing tokens isn't killed.
4. **Live streaming to the UI** — `message.part.updated` events forward partial text to the browser as an `agent_streaming` WebSocket event; you see a pulsing "typing" bubble that fills in as tokens arrive. On turn completion the streaming bubble is replaced by the final transcript entry.
5. **User injection** — the input at the bottom of the transcript view lets you post a `[HUMAN] ...` line into the shared transcript at any time; every agent sees it on their next turn.
6. **Stop / New swarm** — Stop aborts all sessions and kills the spawned processes; the UI then shows a "New swarm" button that returns you to the setup form.

### How the blackboard preset works

Phased implementation notes (now shipped) live in [`docs/blackboard-plan.md`](docs/blackboard-plan.md); a phase-by-phase journal is archived at [`docs/archive/blackboard-changelog.md`](docs/archive/blackboard-changelog.md). The short version:

1. **Planner vs. workers.** Agent 0 is the planner and only posts todos; agents 1..N−1 are workers and only claim + commit. Planner prompts and worker prompts are different loops against the same model. Tool use stays off for workers — they return structured JSON diffs that the Node runner writes to disk, which keeps CAS server-authoritative.
2. **Atomic todos.** Each todo names ≤2 `expectedFiles` and one logical change. Small units keep the conflict surface tiny and make stale replans cheap.
3. **Optimistic CAS on file hashes.** At claim time the board records a SHA of every file the worker plans to touch. At commit time the runner re-hashes and rejects the commit if any hash changed underneath the worker (another worker committed first). No locks, no head-of-line blocking.
4. **Stale → replan.** A rejected commit marks the todo `stale` with a reason. The planner re-reads the current code and rewrites the todo; the card shows an `R1` / `R2` badge counting replans. Workers see the fresh description on the next claim.
5. **Hard caps.** Every run is bounded by **20 min wall-clock**, **20 commits**, and **30 total todos** (see `server/src/swarm/blackboard/caps.ts`). The loop stops on whichever fires first with a `cap:wall-clock` / `cap:commits` / `cap:todos` stop reason.
6. **Run artifact.** On any termination (`completed`, user `stop`, `crash`, or a cap), the runner writes `summary.json` at the clone root with `stopReason`, `wallClockMs`, commit/file counts, per-agent turn stats, and the final `git status --porcelain`. A summary card with the same data renders at the top of the Board tab.
7. **Board tab.** The UI's Board tab shows todos in five columns — **Open** / **Claimed** / **Committed** / **Stale** / **Skipped** — and a collapsible Findings pane. Claim cards show which worker is holding them and how long; stale cards show the rejection reason.

## Prerequisites

- **Node 22 LTS or 25** (CI runs 22.x; local dev tested on both)
- **[Ollama](https://ollama.com) running** at `http://localhost:11434` with at least one model pulled. Default is `glm-5.1:cloud`:
  ```bash
  ollama pull glm-5.1:cloud
  ```
  Optional but recommended: `ollama pull nomic-embed-text` to enable the embedding-similarity drift gauge alongside the LLM-judge conformance gauge.
- **`opencode` CLI** on `PATH`. The dev server spawns one `opencode serve --port N` subprocess per agent.
- **git** on `PATH`. (No need to set `user.name` / `user.email` globally — the worker pipeline injects them inline per-commit.)

## First-time setup

```bash
# 1. Clone + install
git clone https://github.com/kevinkicho/ollama_swarm.git
cd ollama_swarm
npm install

# 2. Configure secrets
cp .env.example .env
# Edit .env — set OPENCODE_SERVER_PASSWORD to any string.
# It's the HTTP-basic-auth secret shared with the spawned opencode subprocesses.

# 3. Start the dev server (backend + frontend together)
npm run dev
```

`npm run dev` binds the backend to `127.0.0.1:8243` and the web app to `[::1]:8244` (override via `SERVER_PORT` / `WEB_PORT`).

### Your first run

1. Open **http://localhost:8244/** (or the WSL guest IP if you're hitting it from Windows — see `ip addr show eth0` for the address).
2. The Setup Form opens by default. Fill in:
   - **GitHub URL** — public repo, or private if you set `GITHUB_TOKEN` in `.env`
   - **Parent folder** — absolute path to the directory the repo will be cloned INTO (the form previews the resolved clone path)
   - **Pattern** — pick from the 9 presets. Hover the "?" next to "Preset" for a rich tooltip showing the preset's metadata + directive behavior
   - **User directive (optional)** — what you want the swarm to do. Required for the conformance gauge to fire. Blackboard uses this to seed the planner's contract; discussion presets pass it as context.
3. Hit **Start swarm**. The transcript streams in real-time. Switch to the **Board** tab during a blackboard run to watch todos move through Open → Claimed → Committed.
4. The conformance gauge appears in the topbar after ~90s. Drift gauge appears next to it if `nomic-embed-text` is installed.
5. Click the **+ nudge** button next to the gauge to submit a mid-run directive amendment when you spot drift.

> If you previously ran on the older default ports (52243 / 52244), those moved on 2026-04-27 to dodge Windows' Hyper-V reserved range. New defaults are 8243 / 8244.

## Usage walkthrough

1. **GitHub URL** — a public repo URL, or a private one if `GITHUB_TOKEN` is set in `.env` (the token is spliced into the clone URL).
2. **Parent folder** — an absolute path to a _parent_ directory. The server derives the repo name from the URL and clones into `<parentFolder>/<repo-name>` (e.g. parent `C:\...\runs` + URL ending in `/is-odd` → clone at `C:\...\runs\is-odd`). Parent is created if missing; the subfolder must be empty, absent, or already a matching git clone. The form shows a live preview of the resolved clone path under the field.
3. **Pattern** — one of the eight listed at the top of this README. Selecting blackboard reveals collapsible help explaining CAS and stale-replan; each pattern's `<PresetAdvancedSettings>` panel shows pattern-specific knobs.
4. **Agents** — how many concurrent agents to spawn (2–8 for most presets). On blackboard, agent 1 is the planner and the remaining N−1 are workers. `debate-judge` requires exactly 3; `map-reduce` and `orchestrator-worker-deep` require ≥4.
5. **Rounds** — for discussion presets: how many full passes through the agents. For blackboard: the maximum number of **auditor invocations** (plan → work → audit cycles) before the run stops even if unresolved criteria remain. Blackboard still stops earlier on the hard caps (per-run `wallClockCapMs` defaults to **8 hours** if not set, plus baked-in 200-commits / 300-todos backstops) or when every criterion is resolved. The cap is enforced by a 5s-tick watchdog (`#305`), so runs stop within ~5 seconds of the threshold rather than waiting for the next phase boundary. With non-blackboard presets, high values can mean hours of wall-clock and proportional cloud-token spend.
6. **Model** — any model string registered in Ollama and declared in the synthesized `opencode.json` (defaults to `glm-5.1:cloud`).

Hit Start. You'll see each agent panel go from `spawning` → `ready` → `thinking` → `ready`, with live streaming bubbles in the transcript as each agent works. On blackboard runs, switch to the **Board** tab to watch todos flow through Open → Claimed → Committed (or Stale → back to Open on CAS rejection). When the run terminates the phase pill flips to `completed` / `stopped` / `failed` and a summary card appears at the top of the Board tab; a **New swarm** button is available in the sidebar.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENCODE_SERVER_USERNAME` | no (defaults to `opencode`) | HTTP basic auth username used by every spawned opencode subprocess |
| `OPENCODE_SERVER_PASSWORD` | **yes** | HTTP basic auth password — any string; shared with spawned subprocesses |
| `OLLAMA_BASE_URL` | no (defaults to `http://localhost:11434/v1`) | OpenAI-compatible Ollama endpoint, written into each agent's synthesized `opencode.json`. **Must end in `/v1`** — the proxy defensively appends it if missing (commit `bb0c509`). |
| `DEFAULT_MODEL` | no (defaults to `glm-5.1:cloud`) | Model each agent uses when the form's model field is left blank. `nemotron-3-super:cloud` and `glm-5.1:cloud` remain available — type explicitly in the form. |
| `OPENCODE_BIN` | no (defaults to `opencode`) | Path/name of the opencode CLI binary |
| `SERVER_PORT` | no (defaults to `8243`) | Override the backend HTTP+WS port |
| `WEB_PORT` | no (defaults to `8244`) | Override the Vite dev-server port |
| `USE_OLLAMA_DIRECT` | no (defaults off) | Bypass opencode SDK; talk to Ollama directly. Honored by `BlackboardRunner`. |
| `GITHUB_TOKEN` | no | GitHub PAT for cloning private repos |
| `CONFORMANCE_MONITOR` | no (defaults on) | Set to `off` to skip the LLM-judge conformance gauge for runs with a directive |

## Project structure

Three npm workspaces:

- **`server/`** — Express + ws + `@opencode-ai/sdk` + `simple-git` + zod. Hosts the runners, the AgentManager, the proxy, and the REST + WS routes.
- **`web/`** — Vite + React + Zustand + Tailwind. Setup form, transcript, board, run-history modal.
- **`shared/`** — pure types + parsers consumed by both sides (state machine reducer, JSON extractors, summary formatter).

For the current per-file map (with V2 substrate files, route mounts, and per-component layout) see the **Where things live** section in [`docs/STATUS.md`](docs/STATUS.md). For per-function detail, the code is the source of truth — open the file.

## Limitations

See [`docs/known-limitations.md`](docs/known-limitations.md) for the full list with rationale + resolution status. Headline items today:

- **Blackboard is the only write-capable preset.** All others are discussion-only (run through `swarm-read` agent profile with read-only tools).
- **Worker hunks are search/replace, not patches.** Aider-style `{op: "replace", file, search, replace}` envelope. Falls back closed when the search anchor isn't unique.
- **One swarm at a time.** Stop the current swarm before starting another (or pass `force: true` on `/api/swarm/start`).
- **In-memory transcript** — restarting the server loses live history. Per-run `summary.json` + per-event `logs/current.jsonl` are durable; the run-history dropdown reads the former.
- **Localhost assumed.** No auth on the web app itself.
- **OpenCode subprocess remains a runtime dep.** V2 substrate (state machine, TodoQueue, WorkerPipeline, OllamaClient) is now the primary path; the V1 SDK loop was retired 2026-04-28. Dropping the subprocess entirely is feasible via `USE_OLLAMA_DIRECT=1` but not yet the default for all presets.
- **`/mnt/c` (WSL) flakiness.** tsx watch occasionally SIGTERMs the dev server when files in `/mnt/c` change rapidly; restart the dev server when this happens. Does not affect production.

## Troubleshooting

- **`OPENCODE_SERVER_PASSWORD is required in .env`** — you haven't copied `.env.example` to `.env` or haven't set the password.
- **Agents spawn but every turn errors with `fetch failed` / 404 on `/chat/completions`** — usually Ollama isn't running, the model isn't pulled, or `OLLAMA_BASE_URL` is missing the `/v1` suffix. The proxy now defensively appends `/v1` (commit `bb0c509`), but check `curl http://localhost:11434/api/tags` first.
- **Empty agent responses across multiple presets** — most often the `/v1` issue above. If that's clean, check `streamPrompt` isn't getting stale `session.idle` from a prior prompt's tail (commit `18a7749` filters this).
- **Port conflicts** — defaults are `SERVER_PORT=8243` / `WEB_PORT=8244`. If something else is bound, set either env var to a free port and restart. On Windows, check `netsh int ipv4 show excludedportrange protocol=tcp` if you get `EACCES` — Windows reserves chunks of ports for Hyper-V.
- **`turn silent for Ns` errors** — the SSE-aware watchdog (commit `189ca05`) aborts on 90s SSE silence OR a 30-min hard ceiling. Long-tail latency that's still producing tokens isn't killed. The swarm will continue on the next agent; check the `[agent-N]` lines in the backend terminal for the underlying opencode error.

## License

MIT — see [`LICENSE`](LICENSE).
