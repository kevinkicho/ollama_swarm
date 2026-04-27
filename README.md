# ollama_swarm

> **For agents picking up this codebase**: read [`docs/STATUS.md`](docs/STATUS.md) first — it's the single "what's true right now" pointer + map. This README is the user-facing intro and skews toward stable claims; STATUS.md tracks recent fixes + V2 substrate progress.

A local web app that spawns a **swarm of [OpenCode](https://opencode.ai) agents** — each backed by an [Ollama](https://ollama.com) model such as `glm-5.1:cloud` — to clone a GitHub repository and collaboratively figure out what the project is, what's working, what's missing, and what to build next.

You fill in a GitHub URL, a local clone path, an agent count, and pick a **pattern**. Eight patterns ship today:

- **Round-robin transcript** — N identical agents take turns on a shared transcript; every agent sees every other agent's reply and responds. Discussion-only.
- **Blackboard (optimistic + small units)** — planner posts atomic todos to a shared board; workers claim and commit in parallel, with CAS on file hashes catching stale plans. **The only write-capable preset** — workers actually modify the clone.
- **Role differentiation** — round-robin loop with each agent given a distinct role (Architect, Tester, Security reviewer, etc.). Discussion-only.
- **Council** — N drafters write in private round 1, then read peers' drafts in subsequent rounds and converge. Has early-stop convergence detection. Discussion-only.
- **Orchestrator-worker** (flat + deep) — agent-1 is the lead and dispatches subtasks; agents 2..N execute in parallel. Deep variant adds a mid-tier lead. Discussion-only.
- **Debate-judge** — Pro / Con / Judge (exactly 3 agents). Multi-round structured debate ending in a JSON verdict. Optional post-verdict "build phase" turns Pro into implementer. Discussion-by-default; `executeNextAction: true` enables file edits.
- **Map-reduce** — agent-1 is reducer, agents 2..N are mappers slicing the repo and summarizing in parallel. Convergence detector stops on consecutive empty cycles. Discussion-only.
- **Stigmergy** — pheromone-table + report-out pattern. Discussion-only.

A live transcript streams into the browser as it's generated — you see each agent type token-by-token, can inject your own message into the conversation at any time, and stop the whole thing with one click. The blackboard preset adds a **Board** tab showing todos in five columns (Open / Claimed / Committed / Stale / Skipped), plus a run summary card when the run terminates.

**See [`docs/ARCHITECTURE-V2.md`](docs/ARCHITECTURE-V2.md) for current architecture status** — the V2 substrate has shipped (state machine, TodoQueueV2, WorkerPipelineV2, OllamaClient, EventLogReaderV2) and is parallel-track instrumented; flip `USE_OLLAMA_DIRECT=1` and `USE_WORKER_PIPELINE_V2=1` to opt the blackboard preset onto the V2 paths.

A live transcript streams into the browser as it's generated — you see each agent type token-by-token, can inject your own message into the conversation at any time, and stop the whole thing with one click. The blackboard preset adds a **Board** tab showing todos in five columns (Open / Claimed / Committed / Stale / Skipped), plus a run summary card when the run terminates.

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

Port 4096 (pre-existing opencode server) = optional orchestrator voice /
                                           human-in-the-loop surface
```

### How the round-robin preset works

1. **Seed** — a system message drops the clone path, repo URL, and top-level file listing into the shared transcript, and instructs agents to use their own file-read / grep / find tools to inspect the repo.
2. **Round-robin turn loop** — for `rounds` iterations, each agent in turn receives a prompt containing the **entire transcript so far** plus role instructions ("you are Agent N, respond in under 250 words, cite file paths"). The agent uses OpenCode tools to read files and produces a reply.
3. **Event-driven idle watchdog** — we don't use a fixed wall-clock timeout. Each agent's opencode server pushes SSE events (`message.part.updated`, `session.idle`, `session.error`, etc.); as long as events keep flowing for the active session, we keep waiting. We only abort a turn if the session has been completely silent for 2 minutes, with a hard 20-minute ceiling as a safety net.
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

- **Node 20+**
- **`opencode` CLI** on `PATH` (the dev server spawns one `opencode serve --port N` subprocess per agent; the binary is required, but you do **not** need to keep a long-running opencode at port 4096 — that requirement was vestigial and got documented away).
- **`OPENCODE_SERVER_PASSWORD`** in `.env` — any string, used as the shared HTTP-basic-auth secret with the spawned subprocesses.
- **Ollama** running at `http://localhost:11434` with your desired model pulled (e.g. `ollama pull glm-5.1:cloud`).
- **git** on `PATH`.

## Setup

```bash
git clone https://github.com/kevinkicho/ollama_swarm.git
cd ollama_swarm
cp .env.example .env
# Fill in OPENCODE_SERVER_PASSWORD to match whatever your port-4096 server uses
npm install
npm run dev
```

`npm run dev` starts both the backend and the frontend in one process, each on a **randomly picked free port** (written to `.server-port` so the Vite dev server can target the backend via proxy). Your terminal will print something like:

```
[dev] backend :56608  ·  web :56609  (wrote .server-port)
```

Open the web URL shown (e.g. `http://localhost:56609`), fill in the form, hit **Start swarm**.

## Usage walkthrough

1. **GitHub URL** — a public repo URL, or a private one if `GITHUB_TOKEN` is set in `.env` (the token is spliced into the clone URL).
2. **Parent folder** — an absolute path to a _parent_ directory. The server derives the repo name from the URL and clones into `<parentFolder>/<repo-name>` (e.g. parent `C:\...\runs` + URL ending in `/is-odd` → clone at `C:\...\runs\is-odd`). Parent is created if missing; the subfolder must be empty, absent, or already a matching git clone. The form shows a live preview of the resolved clone path under the field.
3. **Pattern** — one of `Round-robin transcript` (discussion-only), `Blackboard (optimistic + small units)` (planner/worker split, CAS, file edits), or `Role differentiation` (round-robin with per-agent role prompts). Selecting blackboard reveals a collapsible help block explaining CAS and stale-replan; remaining patterns in the dropdown are marked _coming soon_ and disable **Start**.
4. **Agents** — how many concurrent `opencode serve` workers to spawn (2–8). On blackboard, agent 0 is the planner and the remaining N−1 are workers.
5. **Rounds** — for round-robin/role-diff/council: how many full passes through the agents (1–100). For blackboard: the maximum number of **auditor invocations** (plan → work → audit cycles) before the run stops even if unresolved criteria remain. Blackboard still stops earlier on the hard caps (20 min wall-clock / 20 commits / 30 todos) or when every criterion is resolved. With non-blackboard presets, high values can mean hours of wall-clock and proportional cloud-token spend.
6. **Model** — any model string registered in Ollama and declared in the synthesized `opencode.json` (defaults to `glm-5.1:cloud`).

Hit Start. You'll see each agent panel go from `spawning` → `ready` → `thinking` → `ready`, with live streaming bubbles in the transcript as each agent works. On blackboard runs, switch to the **Board** tab to watch todos flow through Open → Claimed → Committed (or Stale → back to Open on CAS rejection). When the run terminates the phase pill flips to `completed` / `stopped` / `failed` and a summary card appears at the top of the Board tab; a **New swarm** button is available in the sidebar.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENCODE_SERVER_USERNAME` | no (defaults to `opencode`) | HTTP basic auth username used by every opencode server |
| `OPENCODE_SERVER_PASSWORD` | **yes** | HTTP basic auth password — must match your port-4096 server |
| `OPENCODE_BASE_URL` | no (defaults to `http://127.0.0.1:4096`) | Location of your pre-existing "orchestrator voice" opencode server |
| `OLLAMA_BASE_URL` | no (defaults to `http://localhost:11434/v1`) | OpenAI-compatible Ollama endpoint, written into each agent's synthesized `opencode.json` |
| `DEFAULT_MODEL` | no (defaults to `glm-5.1:cloud`) | Model each agent uses when the form's model field is left blank |
| `OPENCODE_BIN` | no (defaults to `opencode`) | Path/name of the opencode CLI binary |
| `SERVER_PORT` | no (defaults to `52243`) | Override the backend HTTP+WS port |
| `WEB_PORT` | no (defaults to `52244`) | Override the Vite dev-server port |
| `GITHUB_TOKEN` | no | GitHub PAT for cloning private repos |

## Project structure

```
ollama_swarm/
├── package.json              # npm workspaces root (server + web)
├── scripts/
│   └── dev.mjs               # single-process dev runner (pins backend:52243, web:52244; override via SERVER_PORT / WEB_PORT)
├── .env.example              # copy to .env and fill in OPENCODE_SERVER_PASSWORD
├── .gitignore
├── README.md
├── server/
│   ├── package.json          # express, ws, @opencode-ai/sdk, simple-git, zod, dotenv
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # HTTP + WS bootstrap, crash guards, graceful shutdown
│       ├── config.ts         # zod-validated env loading, basic-auth header helper
│       ├── types.ts          # shared DTOs (AgentState, TranscriptEntry, SwarmEvent, SwarmPhase)
│       ├── routes/
│       │   └── swarm.ts      # POST /api/swarm/start /stop /say, GET /status
│       ├── services/
│       │   ├── PortAllocator.ts   # net.createServer(0) free-port probe with reservation set
│       │   ├── RepoService.ts     # simple-git clone, synthesize opencode.json, README read helper
│       │   ├── AgentManager.ts    # spawn opencode serve, SDK client, SSE event subscription
│       │   └── Orchestrator.ts    # turn loop, transcript, idle watchdog, prompt builder
│       └── ws/
│           └── broadcast.ts  # tiny WebSocketServer wrapper with per-client send
└── web/
    ├── package.json          # react, zustand, vite, tailwind
    ├── vite.config.ts        # picks backend port from .server-port, proxies /api
    ├── tailwind.config.js    # custom "ink" palette
    ├── postcss.config.js
    ├── index.html            # favicon + root mount
    ├── public/
    │   └── favicon.svg       # three colored dots representing the swarm
    └── src/
        ├── main.tsx          # React root, StrictMode
        ├── App.tsx           # top-level router: SetupForm vs SwarmView + phase pill
        ├── index.css         # Tailwind directives + base styles
        ├── env.d.ts          # __BACKEND_PORT__ global declaration
        ├── types.ts          # mirror of server types (AgentState, SwarmEvent, SwarmPhase, …)
        ├── state/
        │   └── store.ts      # zustand store: phase, agents, transcript, streaming, error
        ├── hooks/
        │   └── useSwarmSocket.ts  # module-level WebSocket singleton + auto-reconnect
        └── components/
            ├── SetupForm.tsx      # the initial form (repo URL, path, agent count, rounds, model)
            ├── SwarmView.tsx      # sidebar of agent panels + transcript + inject-message input
            ├── AgentPanel.tsx     # per-agent status dot + port + error
            └── Transcript.tsx     # message bubbles, streaming "typing" bubble, collapse for long text
```

> The tree above is the stable shape. For the current per-file map of recently-added modules (V2 substrate, shared/, route additions, etc.) see the "Where things live" section in [`docs/STATUS.md`](docs/STATUS.md). For per-function detail, the code is the source of truth — open the file.

## Limitations

See [`docs/known-limitations.md`](docs/known-limitations.md) for the full list with rationale + resolution status. Headline items today:

- **Blackboard is the only write-capable preset.** All others are discussion-only (run through `swarm-read` agent profile with read-only tools).
- **Worker hunks are search/replace, not patches.** Aider-style `{op: "replace", file, search, replace}` envelope. Falls back closed when the search anchor isn't unique.
- **One swarm at a time.** Stop the current swarm before starting another (or pass `force: true` on `/api/swarm/start`).
- **In-memory transcript** — restarting the server loses live history. Per-run `summary.json` + per-event `logs/current.jsonl` are durable; the run-history dropdown reads the former.
- **Localhost assumed.** No auth on the web app itself.
- **OpenCode subprocess remains a runtime dep.** V2 substrate (state machine, TodoQueueV2, WorkerPipelineV2, OllamaClient) has shipped but is opt-in via env flags. Dropping the subprocess entirely is ~1 week of focused refactor; see `docs/ARCHITECTURE-V2.md` Status section.
- **`/mnt/c` (WSL) flakiness.** tsx watch occasionally SIGTERMs the dev server when files in `/mnt/c` change rapidly; restart the dev server when this happens. Does not affect production.

## Troubleshooting

- **`OPENCODE_SERVER_PASSWORD is required in .env`** — you haven't copied `.env.example` to `.env` or haven't set the password.
- **Agents spawn but every turn errors with `fetch failed`** — usually Ollama isn't running, the model isn't pulled, or your pre-existing port-4096 opencode server rejected basic auth. Check `curl http://localhost:11434/api/tags` and that `OPENCODE_SERVER_PASSWORD` matches your 4096 server.
- **Port conflicts** — defaults are `SERVER_PORT=52243` / `WEB_PORT=52244`. If something else is bound, set either env var to a free port and restart.
- **`turn silent for Ns` errors** — the opencode server stopped emitting events for a session mid-turn (often an Ollama hang). The swarm will continue on the next agent; check the `[agent-N]` lines in the backend terminal for the underlying opencode error.

## License

MIT (or as you prefer — add a `LICENSE` file if publishing).
