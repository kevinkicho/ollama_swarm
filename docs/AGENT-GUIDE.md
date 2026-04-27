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
5. **`docs/ARCHITECTURE-V2.md`** — V2 rewrite roadmap with current shipped status
6. **`docs/known-limitations.md`** — deliberate trade-offs + V2 mitigations
7. **`server/src/swarm/blackboard/ARCHITECTURE.md`** — code-near design intent for the blackboard module (read before editing files in that dir)

Memory (`~/.claude/projects/-mnt-c-Users-kevin-Desktop-ollama-swarm/memory/MEMORY.md`) is loaded into your context automatically — don't re-read it explicitly.

---

## Common commands

### Run tests

```bash
cd server && npm test
```

The script in `server/package.json` is prefixed with
`OPENCODE_SERVER_PASSWORD=test-only`. If you run a test file directly,
include that prefix or the import-time zod validation in `config.ts`
will fail before any test runs. See
`reference_test_command_password` memory.

Currently 972/972 passing.

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

**Kevin runs `npm run dev` from Windows PowerShell.** The setup is WSL ↔ Windows: `node_modules` is shared but esbuild binaries are platform-specific. **Don't run `npm install` or naked `npm run dev` from WSL** — see `feedback_wsl_windows_esbuild` memory.

If you need the dev server up from a WSL session, spawn it as a Windows process via `cmd.exe`:

```bash
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && set USE_OLLAMA_DIRECT=1&& set USE_WORKER_PIPELINE_V2=1&& npm run dev"
```

Or use the longer post-reboot recipe with explicit env-var inlining (`reference_dev_server_from_wsl` memory). Drop the `USE_*` env vars to run V1 paths.

For long validation runs where you want to avoid `/mnt/c` inotify SIGTERM flakes (the tsx watch occasionally killing the dev server after summary writes), append `--no-watch`:

```bash
cmd.exe /c "...npm run dev -- --no-watch"
```

Trade-off: code edits won't auto-restart the server. Best for "fire a swarm, wait, capture results" workflows.

Health: `curl -s http://localhost:8243/api/health` should return `{"ok":true,...}`. V2 flag inspection: `curl -s http://localhost:8243/api/v2/status`.

### Standard monitor trio (use ALL THREE on every run)

Whenever you fire a swarm run, attach all three monitors in background. Each captures a different layer; together they're the only way to debug what actually happened. Kevin can't reliably describe UI bugs ("dom name or class/id" not knowable to him) — these scripts are how YOU see what the user sees.

```bash
# Issue monitor — REST polling, classifies known bugs, agent-death detection
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\monitor-blackboard-issues.mjs --port=8243 --runId=$RUNID --runDir=runs/_monitor/$RUNID --maxWaitMin=22"

# Snapshot capturer — periodic full /api/swarm/status JSON dump (time-series)
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\capture-status-snapshots.mjs --port=8243 --runId=$RUNID --runDir=runs/_monitor/$RUNID --intervalSec=30 --maxWaitMin=22"

# UI watcher — Playwright opens the UI, captures WS frames + console + screenshots + DOM continuously
cmd.exe /c "cd /d C:\\Users\\kevin\\Desktop\\ollama_swarm && node scripts\\watch-ui-during-run.mjs --webUrl=http://localhost:8244 --runId=$RUNID --runDir=runs/_monitor/$RUNID --intervalSec=30 --maxWaitMin=22"
```

Each writes to its own subdir under `runs/_monitor/<runId>/`. After the run, check:
- `issues-report.md` — per-issue verdict + agent-death section
- `snapshots/index.jsonl` — phase + board-counts time-series
- `playwright/ui-watcher-report.md` — WS event breakdown + console errors
- `playwright/screenshots/` — visual evolution of the UI
- `playwright/ws-frames-received.jsonl` — every event the UI rendered

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

## Conventions

### Commit style

Use HEREDOC for multi-line messages so formatting survives. Always with the explicit identity flag (Kevin's git config isn't set in WSL):

```bash
git -c user.name='Kevin' -c user.email='kevinkicho@gmail.com' commit -m "$(cat <<'EOF'
short one-line subject

Optional body explaining the WHY (not the WHAT — the diff shows what).
Reference task IDs / commits / RCAs by their short hash.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Where new code goes

- **Logic shared between server and web** → `shared/src/` (single source of truth; no per-side mirroring)
- **V2 substrate that should be opt-in** → `server/src/swarm/blackboard/` with a `V2` suffix on the filename (e.g., `TodoQueueV2.ts`, `WorkerPipelineV2.ts`)
- **Tests** → next to the file under test as `X.test.ts`; add to `server/package.json`'s `test` script
- **Routes** → `server/src/routes/` named after the API surface (e.g., `v2.ts` for `/api/v2/*`)
- **Per-runner specialization** → one runner class per preset under `server/src/swarm/`; share retry / watchdog logic via helpers (`promptWithRetry`, `sseAwareTurnWatchdog`)
- **Docs** → `docs/` for cross-cutting concerns; co-locate code-near design notes as `ARCHITECTURE.md` next to the module
- **Per-clone files** → written to the cloned repo at `runs/<name>/`. Includes `summary.json`, `summary-<iso>.json`, `opencode.json`, `.swarm-design/`, `.swarm-memory.jsonl`. Don't add new files to the repo root via this path without a good reason (the user's repo gets noise).

### When making behavior changes

- **Default OFF** for risky / experimental behavior. Add an env flag (e.g., `USE_OLLAMA_DIRECT`, `USE_WORKER_PIPELINE_V2`) that opts in.
- **Parallel-track first.** Wire new substrate alongside existing code; run both in parallel; compare via divergence detection (see `RunStateObserver` for the pattern). Cut over only after stable validation.
- **Tests before integration.** Substrate gets unit tests + an integration test demonstrating composition; that lets the integration step be confident.
- **Document RCA in the commit body.** For non-trivial bug fixes, include enough detail in the commit message that future-you can understand WHY the fix is correct without re-discovering the symptom.

### Don't

- **Don't push without explicit user approval.** Commits are fine; pushes are shared-state actions.
- **Don't run `npm install` from WSL.** It swaps esbuild binaries to Linux; Kevin's next Windows dev-server boot then fails. See `feedback_wsl_windows_esbuild` memory.
- **Don't do `git config --global` for any reason.**
- **Don't burn cloud quota for "preset tour" or "long-run validation" without explicit go-ahead.** The user's per-run threshold is "10+ min E2E" per `feedback_phased_work` memory.
- **Don't accept "pre-existing failures" uncritically.** Always investigate the root cause; the 2 long-standing test failures turned out to be one missing env var (commit `3ad6869`).
- **Don't pile up background tasks.** When restarting the dev server, use `TaskStop` on the previous task instead of `pkill` after the fact (which strands bash wrappers).
- **Don't auto-schedule `/loop` wakeups beyond what's needed.** They fire in future unrelated sessions and pollute context. See `feedback_loop_premise_expiration` memory.

---

## Operational hazards

### `/mnt/c` (WSL) flakiness

- tsx watch occasionally SIGTERMs the dev server, often shortly after a swarm completes and writes summary files. Just restart. See `reference_wsl_sigterm_after_summary` memory.
- `npm install` from WSL swaps esbuild binaries — never do it from Linux. See `feedback_wsl_windows_esbuild`.
- File-change events on `/mnt/c` need polling-based watchers. See `feedback_wsl_pitfalls`.

### Cloud quota

- The default planner model (`deepseek-v4-pro:cloud` since 2026-04-27; previously `glm-5.1:cloud`) can take 30–180s for first prompt cold-start. The SSE-aware watchdog (commit `189ca05`) accepts this as long as SSE chunks are flowing. `glm-5.1:cloud` specifically had a documented empty-response failure mode on parallel-spawn fanout (Pattern 5 in `project_run_patterns` memory); kept available but no longer default.
- Quota walls (HTTP 429/503) trigger blackboard's `enterPause()` with 5-min probe loop, capped at 2h total pause before halting. Other presets fail-fast.
- Token tracker captures via local proxy at `:11533`. Per-run totals visible in `RunSummary.totalPromptTokens` / `totalResponseTokens`.

### Background process management

- Each swarm spawns N opencode subprocesses on random ports.
- `AgentManager.killAll()` does verified-kill (poll `tasklist /PID` after `taskkill /F /T`).
- On dev-server startup, `reclaimOrphans` reads `logs/agent-pids.log` and kills any leftover PIDs from a prior crashed server.
- If you suspect zombies: `ps -ef | grep -E "tsx watch|npm run dev|opencode serve" | grep -v grep` then `pkill -9 -f "..."` (note: this strands bash wrappers; cleaner to `TaskStop` background tasks).

---

## Where to ask "is this safe?"

- **File deletion** → confirm with user
- **Force push, reset --hard, branch delete** → confirm with user
- **Cloud-quota burn ≥10 min** → confirm with user
- **Schema-breaking changes** → confirm with user
- **Deleting/renaming public APIs** → confirm with user
- **Editing inside `runs/`** → confirm (those are user repos)
- **Editing `.env`** → confirm

For UI/UX/code judgment calls, prefer "pick + ship + annotate" over asking. See `feedback_drive_dont_ask` memory.
