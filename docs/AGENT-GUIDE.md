# Agent guide — day-1 essentials

> If you're an AI agent picking up this codebase, read this first
> (after `STATUS.md`). It's the operational stuff that's not in
> code or product docs but you'll re-discover the hard way otherwise.

---

## Reading order

1. **`docs/STATUS.md`** — what's true right now (preset list, V2 substrate state, file tree, active design constraints)
2. **`docs/AGENT-GUIDE.md`** — this file (commands, conventions, gotchas)
3. **`docs/active-work.md`** — what's queued/blocked/in-flight across sessions
4. **`docs/decisions/`** — short ADRs for non-obvious "why this not that" choices
5. **`docs/known-limitations.md`** — deliberate trade-offs + V2 mitigations
6. **`server/src/swarm/blackboard/ARCHITECTURE.md`** — code-near design intent for the blackboard module (read before editing files in that dir)

Memory (`~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md`) is loaded into your context automatically — don't re-read it explicitly.

---

## Common commands

### Run tests

```bash
npm test
```

Works from the repo root, any shell. The runner shim
(`server/scripts/run-tests.mjs`) sets `OPENCODE_SERVER_PASSWORD=test-only`
on the spawned process if not already set.

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

`npm run dev` works from WSL or Windows. The only WSL hazard is `npm install` — it swaps esbuild binaries to Linux and breaks the Windows dev-server. See `feedback_wsl_windows_esbuild` memory.

For long validation runs where you want to avoid `/mnt/c` inotify SIGTERM flakes (the tsx watch occasionally killing the dev server after summary writes), append `--no-watch`:

```bash
npm run dev -- --no-watch
```

Health: `curl -s http://localhost:8243/api/health` should return `{"ok":true,...}`.

### Server restart rules (CRITICAL)

**NEVER use `setsid sh -c '...' &` to start servers.** This freezes opencode. Use `npm run dev` directly or `npx tsx src/index.ts` in the foreground.

**After ANY code edit**, restart BOTH servers:
```bash
kill-port 8243 8244   # kill backend + frontend
npm run dev            # starts both (from repo root)
```

**Why both ports:** 8243 = backend (tsx), 8244 = frontend (vite). They are separate processes.

**Pre-commit check:** Always run `npm run build` before committing to catch TypeScript errors. Tests passing (`npm test`) does NOT mean the build passes — tests use tsx (lenient), build uses tsc (strict).

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

The council preset is the most complex preset. Here's how it works:

### 3-phase autonomous cycle

1. **Phase 1 (Analysis):** N agents debate independently (Round 1), then revise based on peer drafts (Round 2+). Synthesis consolidates into consensus. Early convergence detection ends discussion if consensus is reached.

2. **Phase 2 (Execution):** Agents work in parallel on extracted todos. The `claimed` set prevents two agents from grabbing the same todo. No file locking — agents can work on different parts of the same file or create new files.

3. **Phase 3 (Audit):** All agents inspect the changes. Detects contradictions (agents undid each other's work) and partial work (incomplete items). Creates follow-up todos for the next cycle.

### AI-driven decision gates

- **Gate 1 (verifyTodo):** Before executing a todo, AI verifies the expected files exist on disk. Catches bad file paths from todo extraction.

- **Gate 3 (resolveContradiction):** When audit detects contradictions, AI reads the actual git diffs and decides: keep-first, keep-second, merge, or revert-both. Falls back to generic extraction if AI can't determine resolution.

- **Gate 4 (recoverDeletedFiles):** When contradictions involve deleted files, AI decides which should be restored vs. intentionally removed.

### File structure

```
server/src/swarm/
├── CouncilRunner.ts      (499 LOC) — Main orchestration, loop, seed
├── councilDecisions.ts   (707 LOC) — Gate 1-4, todo extraction
├── councilExecution.ts   (207 LOC) — Parallel worker execution
├── councilAudit.ts       (149 LOC) — Audit phase
├── councilSynthesis.ts   (180 LOC) — Synthesis pass
├── councilDeliverable.ts (242 LOC) — Deliverable writing
└── councilVoteReconcile.ts (95 LOC) — Vote reconciliation
```

### Autonomous loop

When `rounds: 0` (infinite mode), the council cycles through all 3 phases repeatedly:
- Cycle 1: Full discussion → execution → audit
- Cycle 2+: Uses carry-forward todos from audit, or re-plans from scratch
- Cycle cap: 20 planning cycles maximum
- Execution-audit sub-cycle cap: 8 cycles for fixing incomplete work

Contradictions and partial work are logged; the next synthesis accounts for them naturally. No fallback todos needed.

---

## Conventions

### Commit style

Use HEREDOC for multi-line messages so formatting survives. Always with the explicit identity flag:

```bash
git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit -m "$(cat <<'EOF'
short one-line subject

Optional body explaining the WHY (not the WHAT — the diff shows what).
Reference task IDs / commits / RCAs by their short hash.
EOF
)"
```

### Where new code goes

- **Logic shared between server and web** → `shared/src/` (single source of truth)
- **New blackboard substrate** → `server/src/swarm/blackboard/`
- **Tests** → next to the file under test as `X.test.ts`; add the path to the explicit list in `server/scripts/run-tests.mjs` (enumerated, not glob-based)
- **Routes** → `server/src/routes/` named after the API surface
- **Per-runner specialization** → one runner class per preset under `server/src/swarm/`
- **Docs** → `docs/` for cross-cutting concerns; co-locate code-near design notes as `ARCHITECTURE.md` next to the module

### When making behavior changes

- **Default OFF** for risky / experimental behavior. Add an env flag or a `cfg.X?: boolean` opt-in.
- **Tests before integration.** Substrate gets unit tests + an integration test; that lets the integration step be confident.
- **Document RCA in the commit body.** For non-trivial bug fixes, include enough detail that future-you can understand WHY without re-discovering the symptom.

### Don't

- **Don't run `npm install` from WSL.** It swaps esbuild binaries to Linux; Kevin's next Windows dev-server boot then fails.
- **Don't do `git config --global` for any reason.**
- **Don't burn cloud quota for "preset tour" or "long-run validation" without explicit go-ahead.**
- **Don't accept "pre-existing failures" uncritically.** Always investigate the root cause.
- **Don't pile up background tasks.** When restarting the dev server, clean up the previous one first.

---

## Operational hazards

### `/mnt/c` (WSL) flakiness

- tsx watch occasionally SIGTERMs the dev server after summary writes. Just restart.
- `npm install` from WSL swaps esbuild binaries — never do it from Linux.
- File-change events on `/mnt/c` need polling-based watchers.

### Cloud quota

- Quota walls (HTTP 429/503) trigger blackboard's `enterPause()` with 5-min probe loop, capped at 2h total pause before halting. Other presets fail-fast.
- Token tracker captures via local proxy at `:11533`.

### Background process management

Agents are in-process records (no subprocesses since E3 Phase 5). The only OS-level processes are the ones `npm run dev` spawns. If a dev server zombie persists (port still bound after Ctrl-C), find by port: `Get-NetTCPConnection -LocalPort 8243,8244,11533 -State Listen` in PowerShell, then `Stop-Process -Id <pid> -Force`.