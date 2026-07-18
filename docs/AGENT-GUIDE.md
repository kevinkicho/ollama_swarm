# Agent guide — day-1 essentials

> If you're an AI agent picking up this codebase, read this first
> (after `STATUS.md`). It's the operational stuff that's not in
> code or product docs but you'll re-discover the hard way otherwise.

---

## Reading order (for agents)

1. `docs/STATUS.md` (current high-level reality: Brain-OS + FAB chat, concurrent runs, layout, presets, /brain/* routes)
2. `docs/active-work.md` (what has shipped recently + future items)
3. `docs/ARCHITECTURE-VISION.md` (north-star; many phases realized)
4. `docs/AGENT-GUIDE.md` (this file)
5. `docs/known-limitations.md`
6. `server/src/swarm/blackboard/ARCHITECTURE.md` (deep substrate)

Project state lives in the repo: read `docs/STATUS.md`, `docs/active-work.md`, and `docs/ARCHITECTURE-VISION.md`. Legacy `.opencode/` checkpoints and old Claude/opencode memory files have been consolidated/removed; see STATUS for notes.

---

## Hard rules — do not regress

These are intentional product/architecture choices. **Do not reimplement them**
in code, plans, or “helpful” optimizations unless the user explicitly reverses
the decision in `docs/decisions.md`.

| Forbidden | Why |
|-----------|-----|
| **`:cloud` admission / slot queues** (`acquireCloudSlot`, max-N concurrent pipes, “cloud slot” UI) | Removed 2026-07-08. Misleading UX; parallel provider streams are expected. See `docs/decisions.md` → *No client-side `:cloud` admission*. |
| **Wide artificial stagger for `:cloud` only** (e.g. 3s × agent index before prompt) | Same decision — use default `staggerStart` jitter (~150ms) for all models. |
| **Dock copy claiming “request sent” while the app blocks the prompt** | Activity labels must reflect real lifecycle (`markStatus` → provider → streaming), not local throttles. |

If you see a task, comment, or plan that says “cloud admission”, “limit concurrent
:cloud”, or “pipe-handler for parallel bursts”, **stop** and read the decision
doc first.

---

## Common commands

### Run tests

```bash
npm test
```

Works from the repo root, any shell. The runner shim
(`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only`
on the spawned process if not already set.

### Local stack validation (`run-test`)

```bash
npm run run-test
```

Runs unit tests, boots (or reuses) the dev server, probes `/api/health`, and
Playwright-smokes the setup page — **no API keys or LLM required**.

Optional run-start regression (real `POST /api/swarm/start`, needs a configured
provider and `RUN_TEST_LIVE=1`):

```bash
RUN_TEST_LIVE=1 npm run run-test -- --live-smoke
# or
RUN_TEST_LIVE=1 npm run run-test:live
```

Knobs: `RUN_TEST_PRESET` (default `baseline`), `RUN_TEST_START_TIMEOUT_MS`
(default `30000`). Artifacts land in `runs/_run-test-<timestamp>/` including
`logs/live-smoke.json` and `playwright/screenshots/03-run-started.png`.

### Type-check (no emit)

```bash
cd server && npx tsc --noEmit -p tsconfig.json
cd web && npx tsc --noEmit -p tsconfig.json
cd shared && npx tsc --noEmit -p tsconfig.json
```

### Build web bundle

```bash
cd web && npx vite build
```

### Start dev server

`npm run dev` works from WSL or Windows. The only WSL hazard is `npm install` — it swaps esbuild binaries to Linux and breaks the Windows dev-server. Never run npm install from WSL when the repo is on /mnt/c.

For long validation runs where you want to avoid `/mnt/c` inotify SIGTERM flakes (the tsx watch occasionally killing the dev server after summary writes), append `--no-watch`:

```bash
npm run dev -- --no-watch
```

Health: `curl -s http://localhost:8243/api/health` should return `{"ok":true,...}`.

### Server restart rules (CRITICAL)

**NEVER use `setsid sh -c '...' &` to start servers.** (historical note from opencode era). Use `npm run dev` directly.

**After ANY code edit**, restart BOTH servers:
```bash
kill-port 8243 8244   # kill backend + frontend (manual escape hatch)
npm run dev            # starts both (from repo root)
# Ctrl-C in the terminal should cleanly stop both (Windows: readline SIGINT fallback + taskkill /T /F + kill-port safety net in scripts/dev.mjs).
# If a zombie lingers (rare after fixes), use `npx kill-port 8243 8244` or PowerShell Stop-Process.
```

**Why both ports:** 8243 = backend (tsx), 8244 = frontend (vite). They are separate processes.

**Pre-commit check:** Always run `npm run build` before committing to catch TypeScript errors. Tests passing (`npm test`) does NOT mean the build passes — tests use tsx (lenient), build uses tsc (strict).

### Agent tools & internet access

**Short answer:** By default, workers and most agents have **no internet access**.
Enable `webTools: true` or `plannerTools: true` for opt-in `web_search` + `web_fetch`.

Tools (via in-process `ToolDispatcher`, resolved in `shared/src/toolProfiles.ts`):

| Profile                  | Tools                                      | Typical users                  | Internet? |
|--------------------------|--------------------------------------------|--------------------------------|-----------|
| `swarm`                  | none (must emit clean JSON)                | Blackboard workers             | No        |
| `swarm-read`             | `read`, `grep`, `glob`, `list`             | Planners (default), auditors, discussion roles | No (local FS only) |
| `swarm-builder`          | above + restricted `bash`                  | Build / test roles             | No (allowlisted build cmds only, no curl) |
| `swarm-planner`          | read family + bash + `web_search`, `web_fetch` | Planner when `webTools` / `plannerTools` on | Yes (opt-in) |
| `swarm-research`         | read family + `web_search`, `web_fetch`    | Workers/auditors when web tools on | Yes (opt-in) |
| `swarm-builder-research` | builder + `web_search`, `web_fetch`        | Build roles when web tools on  | Yes (opt-in) |

- Web tools require explicit RunConfig flags; not enabled by default.
- `web_search` backends (ordered, first success wins): DuckDuckGo HTML → DuckDuckGo lite → optional paid/free-key APIs when set:
  - `BRAVE_API_KEY` — Brave Search API
  - `SERPER_API_KEY` — Serper (Google SERP)
  - `BING_SEARCH_KEY` — Bing Web Search v7
  Default free path needs no keys. On total failure the tool hard-fails (no invented links) and may append local clone catalog notes when available. See `server/src/tools/searchAdapters.ts`.
- Bash is heavily gated (see `buildCommandAllowlist.ts`).
- MCP (GitHub tools, Playwright) is not generally available to swarm agents.
- Special case: when `MCP_PLAYWRIGHT_ENABLED=true`, the auditor can get browser snapshots for UI criteria.

Directives that require "live web research" (scientific literature, data endpoints, superconductor studies, etc.) should set `webTools: true` + `plannerTools: true`. Use pure council/map-reduce/moa or the pipeline preset for research. See README "Using for Scientific Research & Internet Work" and STATUS preset matrix for current patterns and configs. Local-only workers remain sandboxed.

Relevant code:
- `shared/src/toolProfiles.ts` (profile resolution)
- `server/src/tools/ToolDispatcher.ts`
- `server/src/swarm/blackboard/researchPrePass.ts`
- `server/src/swarm/toolCallTranscript.ts`
- `server/src/swarm/promptWithRetry.ts`
- `RunConfig.webTools` / `RunConfig.plannerTools`

### Ollama proxy (port 11533)

The app runs a local HTTP proxy on port 11533 that sits between the app and the real Ollama server at 11434:

```
App (providers) → 127.0.0.1:11533 (proxy) → localhost:11434 (Ollama)
```

**Why:** The proxy captures token usage (`prompt_eval_count`/`eval_count`) from Ollama responses and detects quota exhaustion (429/503). Without it, token counts are unavailable and quota errors are silent.

**Config:**
- `OLLAMA_PROXY_PORT` — default `11533`. Set to `0` to disable (app connects directly to Ollama).
- `OLLAMA_BASE_URL` — default `http://localhost:11434/v1`. Automatically rewritten to point at the proxy on startup.

**Port 11533 is NOT Ollama itself.** Ollama is always at 11434. The proxy is a thin relay added by this app.

### Concurrent servers (multiple projects)

Run two independent server instances on different ports for parallel projects:

```bash
# Server 1 (kyahoofinance — default log dir)
SERVER_PORT=8243 WEB_PORT=8244 OLLAMA_PROXY_PORT=11533 node scripts/dev.mjs

# Server 2 (ollama_swarm — separate log dir)
SERVER_PORT=9243 WEB_PORT=9244 OLLAMA_PROXY_PORT=21533 LOG_DIR=/tmp/swarm2-logs node scripts/dev.mjs
```

**Each server needs its own:**
- `SERVER_PORT` — backend API port
- `WEB_PORT` — vite dev server port
- `OLLAMA_PROXY_PORT` — proxy for token capture (separate = separate token tracking)
- `LOG_DIR` — event log directory (separate = no mixed run data in UI)

**UI URLs:**
- Server 1: `http://localhost:8244`
- Server 2: `http://localhost:9244`

Both proxies forward to the same Ollama at 11434 — Ollama handles concurrent requests fine.

### Stop / drain — expected behavior

If transcript lines appear **after** “Run stopped” or “ports released”, read
**`docs/run-stop-drain-lifecycle.md`** first. That doc is the contract for:

- Hard stop vs soft drain (`/stop` vs `/drain`)
- Council execution: close-out waits for `workerDrainPromise`, then summary → `killAll`
- Abort signals on all worker provider calls (including literature pre-pass)
- Transcript freeze after summary write (no straggler execution lines)

**Regression smell:** `[agent-N] Literature research`, worker hunks, or
`[execution] Complete:` after the ports-released line.

### Recommended monitors for debugging swarm runs

When debugging a swarm run, these three monitors capture different layers and together provide full visibility:

```bash
# Issue monitor — REST polling, classifies known bugs, agent-death detection
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\monitor-blackboard-issues.mjs --port=8243 --runId=$RUNID --runDir=runs/_monitor/$RUNID --maxWaitMin=22"

# Snapshot capturer — periodic full /api/swarm/status JSON dump (time-series)
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\capture-status-snapshots.mjs --port=8243 --runId=$RUNID --runDir=runs/_monitor/$RUNID --intervalSec=30 --maxWaitMin=22"

# UI watcher — Playwright opens the UI, captures WS frames + console + screenshots + DOM continuously
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\watch-ui-during-run.mjs --webUrl=http://localhost:8244 --runId=$RUNID --runDir=runs/_monitor/$RUNID --intervalSec=30 --maxWaitMin=22"
```

Each writes to its own subdir under `runs/_monitor/<runId>/`.

### Fire a swarm via REST

```bash
curl -s -X POST http://localhost:8243/api/swarm/start \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/kevinkicho/debate-tcg",
    "parentPath": "/mnt/c/Users/kevin/Desktop/ollama_swarm/runs",
    "preset": "role-diff",
    "agentCount": 4,
    "rounds": 3,
    "wallClockCapMs": 1800000,
    "force": true,
    "model": "gemma4:31b-cloud"
  }'
```

`force: true` stops any existing run first. Constraints:
- `debate-judge` requires exactly `agentCount: 3` (Pro/Con/Judge)
- `map-reduce` and `orchestrator-worker-deep` require `agentCount >= 4`
- `wallClockCapMs` is per-run (60s … 8h)

---

## Council preset architecture

The council preset is the most complex preset. Here's how it works (see also `docs/STATUS.md` and `server/src/swarm/CouncilRunner.ts` + extracted modules):

### 3-phase autonomous cycle

1. **Phase 1 (Analysis):** N agents debate independently (Round 1), then revise based on peer drafts (Round 2+). Synthesis consolidates into consensus. Early convergence detection ends discussion if consensus is reached.

2. **Phase 2 (Execution):** Agents work in parallel on extracted todos. The `claimed` set prevents two agents from grabbing the same todo. No file locking — agents can work on different parts of the same file or create new files.

3. **Phase 3 (Audit):** All agents inspect the changes. Detects contradictions (agents undid each other's work) and partial work (incomplete items). Creates follow-up todos for the next cycle.

### Todo extraction (current)

Todo extraction lives in `councilDecisions.ts` (`extractActionableTodos`, `extractTodosFromAudit`). Legacy AI "decision gates" (Gate 1 verifyTodo, Gate 3 resolveContradiction, Gate 4 recoverDeletedFiles) were removed; path validation and simple extraction are used instead. See `councilDecisions.ts` header comment.

**Stop / close-out:** Hard stop aborts in-flight work, waits for the execution pool to
exit (bounded), writes summary, then `killAll`. See `docs/run-stop-drain-lifecycle.md`.

(Additional details on the council refactor live in the source and in `docs/STATUS.md`.)
