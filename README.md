# ollama_swarm

A local web app that spawns a **swarm of [OpenCode](https://opencode.ai) agents** — each backed by an [Ollama](https://ollama.com) model such as `glm-5.1:cloud` — to clone a GitHub repository and collaboratively figure out what the project is, what's working, what's missing, and what to build next.

You fill in a GitHub URL, a local clone path, an agent count, and pick a **pattern**. Three patterns ship:

- **Round-robin transcript** — N identical agents take turns on a shared transcript; every agent sees every other agent's reply and responds. Discussion-only, no file edits.
- **Blackboard (optimistic + small units)** — one planner posts atomic todos to a shared board; N−1 workers claim and commit in parallel, with CAS on file hashes catching stale plans. Agents **actually modify the clone**.
- **Role differentiation** — same round-robin loop but each agent gets a distinct role (Architect, Tester, Security reviewer, Performance critic, Docs reader, Dependency auditor, Devil's advocate). Same weights, different system prompts; transcript labels each line with the role so @mentions stay legible. Discussion-only.

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

Phased implementation notes live in [`docs/blackboard-plan.md`](docs/blackboard-plan.md); a per-commit diary is in [`docs/blackboard-changelog.md`](docs/blackboard-changelog.md). The short version:

1. **Planner vs. workers.** Agent 0 is the planner and only posts todos; agents 1..N−1 are workers and only claim + commit. Planner prompts and worker prompts are different loops against the same model. Tool use stays off for workers — they return structured JSON diffs that the Node runner writes to disk, which keeps CAS server-authoritative.
2. **Atomic todos.** Each todo names ≤2 `expectedFiles` and one logical change. Small units keep the conflict surface tiny and make stale replans cheap.
3. **Optimistic CAS on file hashes.** At claim time the board records a SHA of every file the worker plans to touch. At commit time the runner re-hashes and rejects the commit if any hash changed underneath the worker (another worker committed first). No locks, no head-of-line blocking.
4. **Stale → replan.** A rejected commit marks the todo `stale` with a reason. The planner re-reads the current code and rewrites the todo; the card shows an `R1` / `R2` badge counting replans. Workers see the fresh description on the next claim.
5. **Hard caps.** Every run is bounded by **20 min wall-clock**, **20 commits**, and **30 total todos** (see `server/src/swarm/blackboard/caps.ts`). The loop stops on whichever fires first with a `cap:wall-clock` / `cap:commits` / `cap:todos` stop reason.
6. **Run artifact.** On any termination (`completed`, user `stop`, `crash`, or a cap), the runner writes `summary.json` at the clone root with `stopReason`, `wallClockMs`, commit/file counts, per-agent turn stats, and the final `git status --porcelain`. A summary card with the same data renders at the top of the Board tab.
7. **Board tab.** The UI's Board tab shows todos in five columns — **Open** / **Claimed** / **Committed** / **Stale** / **Skipped** — and a collapsible Findings pane. Claim cards show which worker is holding them and how long; stale cards show the rejection reason.

## Prerequisites

- **Node 20+**
- **`opencode` CLI** on `PATH` with a pre-existing server already listening at `http://127.0.0.1:4096` protected by HTTP basic auth (shared across every `opencode serve` on this machine via `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`).
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
5. **Rounds** — for round-robin/role-diff/council: how many full passes through the agents (1–10). For blackboard: the maximum number of **auditor invocations** (plan → work → audit cycles) before the run stops even if unresolved criteria remain. Blackboard still stops earlier on the hard caps (20 min wall-clock / 20 commits / 30 todos) or when every criterion is resolved.
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

## Function / component reference

### `scripts/dev.mjs`

- **`pickFreePort()`** — binds a server to port `0` on `127.0.0.1`, reads the assigned port, closes, and returns the number.
- **`prefix(tag, color)`** — returns a stream transform that prepends each line with a colored `[tag]`.
- **`launch(name, cwd, args, color)`** — spawns a Node child (tsx or vite) in the given workspace with colored stdout/stderr and death-triggers process shutdown.
- **`shutdown()`** — SIGTERMs every spawned child, escalates to SIGKILL after 4s, then exits.

### `server/src/index.ts`

- Boots Express + `WebSocketServer`, constructs the `AgentManager`, `RepoService`, `Orchestrator`, and `Broadcaster` singletons and wires them together.
- On WS connect, replays the current orchestrator status (phase, agents, full transcript) so a late-joining browser is caught up immediately.
- Registers `GET /api/health` and mounts `swarmRouter` under `/api/swarm`.
- Installs `SIGINT`/`SIGTERM` handlers that call `orchestrator.stop()` before exiting, plus `unhandledRejection`/`uncaughtException` handlers that log the stack and push the error to every connected client.

### `server/src/config.ts`

- **`resolveServerPort()`** — picks the backend port from `SERVER_PORT` env, then from the `.server-port` file written by `dev.mjs` (pinned to `52243` by default), then falls back to `5174`.
- **`Schema`** — zod schema that validates and defaults the remaining env vars (enforces `OPENCODE_SERVER_PASSWORD` is present).
- **`config`** — the merged, typed, validated environment object exported for the rest of the server.
- **`basicAuthHeader()`** — returns the `Basic <base64>` string used to authenticate against every opencode server.

### `server/src/types.ts`

- **`AgentStatus`** — `"spawning" | "ready" | "thinking" | "failed" | "stopped"`.
- **`AgentState`** — per-agent state broadcast to the UI (id, index, port, sessionId, status, lastMessageAt, error).
- **`TranscriptRole`** — `"system" | "user" | "agent"`.
- **`TranscriptEntry`** — one line in the shared transcript.
- **`SwarmPhase`** — `"idle" | "cloning" | "spawning" | "seeding" | "discussing" | "stopping" | "stopped" | "completed"`.
- **`SwarmEvent`** — discriminated union of every event type pushed over the WebSocket (`transcript_append`, `agent_state`, `swarm_state`, `agent_streaming`, `agent_streaming_end`, `error`).
- **`StartSwarmRequest`** — body type for `POST /api/swarm/start`.
- **`SwarmStatus`** — response body of `GET /api/swarm/status`.

### `server/src/routes/swarm.ts`

- **`StartBody`** — zod schema for the start request (validates URL, path, agent count 1–8, rounds 1–10).
- **`SayBody`** — zod schema for the inject-message request.
- **`swarmRouter(orch)`** — returns an Express router wiring `/status`, `/start`, `/stop`, `/say` against the given `Orchestrator`.

### `server/src/services/PortAllocator.ts`

- **`PortAllocator.allocate()`** — probes ephemeral ports until one is both OS-free and not in the reserved set; gives up after 20 tries.
- **`PortAllocator.release(port)`** — removes a port from the reserved set so it can be reused.
- **`PortAllocator.probe()`** *(private)* — binds a TCP server to port 0, reads the OS-assigned port, closes, returns the number.

### `server/src/services/RepoService.ts`

- **`RepoService.clone(opts)`** — creates the destination directory if needed, validates it's empty or already a matching git repo, and shallow-clones the repo via `simple-git` (with `GITHUB_TOKEN` spliced in for private repos).
- **`RepoService.writeOpencodeConfig(clonePath, model)`** — writes an `opencode.json` at the clone root declaring an Ollama OpenAI-compatible provider with the chosen model, so every `opencode serve` in that cwd picks it up.
- **`RepoService.readReadme(clonePath)`** — tries `README.md` / `README` / `README.rst` / `readme.md` and returns the first match, or `null`.
- **`RepoService.listTopLevel(clonePath)`** — returns top-level filenames (directories suffixed with `/`), skipping `.git*`.
- **`RepoService.dirExists(p)`** *(private)* — `fs.stat` wrapper returning `true` only if the path exists and is a directory.
- **`RepoService.withAuth(url)`** *(private)* — if `GITHUB_TOKEN` is set and the URL is `github.com`, rewrites it to `https://<token>@github.com/...`.

### `server/src/services/AgentManager.ts`

- **`authedFetch`** *(module scope)* — `fetch` wrapper that injects the basic-auth header; handles the SDK's `fetch(Request)` pattern without clobbering `Content-Type` or stripping the body.
- **`AgentManager.getOrchestratorClient()`** — lazily constructs the SDK client for the pre-existing `OPENCODE_BASE_URL` server (the port-4096 "human voice").
- **`AgentManager.list()`** — returns spawned agents sorted by their index.
- **`AgentManager.toStates()`** — snapshot of every agent's current state, used for replay on WS reconnect.
- **`AgentManager.getLastActivity(sessionId)`** — returns the timestamp of the last SSE event seen for a session, used by the orchestrator's idle watchdog.
- **`AgentManager.touchActivity(sessionId, ts?)`** — records a fresh activity timestamp for a session.
- **`AgentManager.spawnAgent(opts)`** — allocates a port, spawns `opencode serve`, waits until the `/doc` endpoint responds with basic auth, creates an SDK client, creates a session, starts the SSE subscription, and returns the ready `Agent`.
- **`AgentManager.markStatus(id, status, extra?)`** — updates an agent's UI-visible status.
- **`AgentManager.killAll()`** — aborts every SSE subscription, aborts every session, SIGTERMs every child process, releases every reserved port, and clears the agent map.
- **`AgentManager.waitForReady(port, timeoutMs)`** *(private)* — polls `/doc` with basic auth every 400ms until a 200 response or the deadline passes.
- **`AgentManager.readSessionId(res)`** *(private)* — extracts the session id from a `session.create` response across the SDK's possible response shapes.
- **`AgentManager.startEventStream(agent)`** *(private)* — subscribes to that agent's SSE event stream in the background and routes each event through `handleSessionEvent`.
- **`AgentManager.handleSessionEvent(agent, ev)`** *(private)* — filters to this session's events, updates last-activity, and forwards `message.part.updated` text as `agent_streaming` / `session.idle` as `agent_streaming_end`.

### `server/src/services/Orchestrator.ts`

- **`Orchestrator.status()`** — returns a full status snapshot (phase, round, agents, transcript) used for REST `/status` and WS replay.
- **`Orchestrator.injectUser(text)`** — appends a `role: "user"` entry to the transcript so every agent sees it on their next turn.
- **`Orchestrator.isRunning()`** — `true` when a swarm is live (any non-idle / non-stopped phase).
- **`Orchestrator.start(cfg)`** — drives the full pipeline: clone → write `opencode.json` → spawn N agents → seed the transcript → kick off the discussion loop.
- **`Orchestrator.stop()`** — sets the stop flag, transitions phase to `stopping`, and calls `AgentManager.killAll()`.
- **`Orchestrator.seed(clonePath, cfg)`** *(private)* — posts the kickoff system message (clone path, repo URL, top-level tree, instructions to use file-read tools).
- **`Orchestrator.loop(cfg)`** *(private)* — runs the `rounds × agents` round-robin, emitting a `swarm_state` at each round boundary and transitioning to `completed` at the end.
- **`Orchestrator.runTurn(agent, round, total)`** *(private)* — starts the idle watchdog (aborts only on 2 min of session silence or the 20 min absolute cap), calls `session.prompt` with the full transcript + role prompt, appends the reply as a transcript entry, and translates abort reasons into user-friendly error messages.
- **`Orchestrator.buildPrompt(agent, round, total)`** *(private)* — formats the full transcript and wraps it with role instructions for the current agent.
- **`Orchestrator.appendSystem(text)`** *(private)* — appends a `role: "system"` entry and broadcasts it.
- **`Orchestrator.setPhase(phase)`** *(private)* — updates the phase and broadcasts a `swarm_state` event.
- **`Orchestrator.emitAgentState(s)`** *(private)* — broadcasts an `agent_state` event.
- **`Orchestrator.describeSdkError(err)`** *(private)* — unwraps nested `err.cause` chains so `"fetch failed"` becomes `"fetch failed <- socket hang up [ECONNRESET]"`.
- **`Orchestrator.extractText(res)`** *(private)* — pulls text out of the SDK's `session.prompt` response across its various shapes.

### `server/src/ws/broadcast.ts`

- **`Broadcaster.attach(wss, onConnect)`** — subscribes to new connections on the given WSS, stores each socket in an internal set, and fires the per-connection hook (used to replay state).
- **`Broadcaster.send(ws, event)`** — JSON-stringifies and sends one event to one client, catching send failures and evicting dead sockets.
- **`Broadcaster.broadcast(event)`** — sends one event to every currently-open client (with the same per-socket error handling).

### `web/src/main.tsx`

- React root bootstrap that mounts `<App />` inside `React.StrictMode`.

### `web/src/App.tsx`

- **`App`** — opens the WS singleton, chooses between `SetupForm` and `SwarmView` based on phase, and renders a colored phase pill in the header.
- **`PhasePill`** — a tiny colored badge reflecting the current phase (and the round when discussing).

### `web/src/components/SetupForm.tsx`

- **`SetupForm`** — the initial form (repo URL, local path, agent count, rounds, model); on submit it resets the store and POSTs to `/api/swarm/start`.
- **`Field`** — labeled input wrapper with optional hint text, used throughout the form.

### `web/src/components/SwarmView.tsx`

- **`SwarmView`** — the main two-pane view during a run: sidebar of `AgentPanel`s + transcript + bottom input for injecting a message; the sidebar header toggles between a red "Stop" button (while active) and an emerald "New swarm" button (when terminal).

### `web/src/components/AgentPanel.tsx`

- **`AgentPanel`** — one card per agent showing status color dot, label, port, textual status, and any error message.
- **`STATUS_COLOR`** — map from `AgentStatus` → Tailwind class for the status dot.

### `web/src/components/Transcript.tsx`

- **`Transcript`** — scrollable list of message bubbles, auto-scrolls to the latest entry, and renders any currently-streaming agents as pulsing "typing" bubbles alongside completed transcript entries.
- **`Bubble`** — renders one transcript entry with role-appropriate styling (system / user / agent).
- **`StreamingBubble`** — a live-updating bubble for an in-progress agent reply, with pulsing dots and a soft glow.
- **`Dot`** — one pulsing dot used in the streaming indicator.
- **`CollapsibleBlock`** — body renderer that truncates messages over 600 chars with a "Show more / Show less" toggle.
- **`AGENT_HUE`** — per-agent-index color palette used for bubble borders / text.

### `web/src/state/store.ts`

- **`useSwarm`** — Zustand store with the full client-side swarm state (`phase`, `round`, `agents` map, `transcript`, `streaming` map per agent, `error`).
- **`setPhase / upsertAgent / appendEntry / setStreaming / clearStreaming / setError`** — state mutators called from the WS dispatcher.
- **`reset`** — wipe everything back to idle (called when the user hits "New swarm" or submits a fresh setup form).

### `web/src/hooks/useSwarmSocket.ts`

- **`connect()`** — opens a WebSocket to `ws://host:BACKEND_PORT/ws`, handles `onopen` / `onmessage` / `onclose` / `onerror`, and auto-reconnects with exponential backoff (500ms → 8s).
- **`dispatch(ev)`** — routes incoming `SwarmEvent`s into the corresponding Zustand store mutator.
- **`useSwarmSocket()`** — React hook that kicks off `connect()` once (the socket is a module-level singleton so React StrictMode's double-invoked effect doesn't thrash it).

### `web/vite.config.ts`

- **`resolveBackendPort(mode)`** — reads the backend port the same way `config.ts` does (env → `.server-port` → fallback), exposed as `__BACKEND_PORT__` at build time.
- **Vite config** — React plugin, `/api` proxy to the backend, strict port disabled so Vite can find its own free port when occupied.

### `web/tailwind.config.js`, `web/postcss.config.js`, `web/src/index.css`

- Tailwind configured with a custom "ink" dark palette plus mono font stack; PostCSS runs Tailwind + autoprefixer; `index.css` injects base/components/utilities and makes `html/body/#root` full-height.

## Limitations (v1)

- **Round-robin is discussion-only.** Agents read files via OpenCode tools but don't edit the clone in this preset. File edits happen in the blackboard preset.
- **Blackboard diffs are full-file replacements.** Workers return `{file, newText}` rather than patches — blunt but trivially validatable; patch-based diffs are a v2 concern.
- **One swarm at a time.** You must Stop the current swarm before starting another.
- **In-memory transcript.** Restarting the server loses history. The blackboard preset also writes `summary.json` and (on crash) `board-final.json` to the clone root, so terminal state survives.
- **Localhost assumed.** No authentication on the web app itself.
- **Round-robin has no consensus detection.** The loop always runs all configured rounds. Blackboard terminates on hard caps, user stop, or an empty board after planning.
- **Other patterns in the dropdown are `coming soon`.** Map-reduce, council, orchestrator-worker, debate+judge, and stigmergy all disable the Start button for now.

## Troubleshooting

- **`OPENCODE_SERVER_PASSWORD is required in .env`** — you haven't copied `.env.example` to `.env` or haven't set the password.
- **Agents spawn but every turn errors with `fetch failed`** — usually Ollama isn't running, the model isn't pulled, or your pre-existing port-4096 opencode server rejected basic auth. Check `curl http://localhost:11434/api/tags` and that `OPENCODE_SERVER_PASSWORD` matches your 4096 server.
- **Port conflicts** — defaults are `SERVER_PORT=52243` / `WEB_PORT=52244`. If something else is bound, set either env var to a free port and restart.
- **`turn silent for Ns` errors** — the opencode server stopped emitting events for a session mid-turn (often an Ollama hang). The swarm will continue on the next agent; check the `[agent-N]` lines in the backend terminal for the underlying opencode error.

## License

MIT (or as you prefer — add a `LICENSE` file if publishing).
