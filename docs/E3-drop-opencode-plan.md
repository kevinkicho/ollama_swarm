# E3 — Drop the opencode subprocess dependency

> **Status:** planning. No code changes in this commit. Next session that picks this up should follow the phases below in order, with a checkpoint commit after each phase.

## Why

Today every agent is a real `opencode serve` subprocess on a random TCP port. We use opencode for: spawning the LLM session, streaming SSE events, message persistence, agent profiles + tool grants, and (post-#314) routing prompts to Ollama / Anthropic / OpenAI via AI-SDK packages.

Dropping it means:

- **No subprocess overhead.** Spawning one `opencode serve` per agent costs ~100MB RAM + ~5–10s warmup. A 4-agent run pays 400MB + 20–40s before the first prompt fires.
- **Single-binary install.** Users need only Ollama (or an API key). No `opencode` CLI on `PATH`.
- **Direct control.** Today's HTTP+SSE roundtrip into opencode hides bugs (auth-header path is one we already burned hours on). Owning the session loop end-to-end means easier diagnostic.

## What it costs us

- **Re-implementing what opencode does for free.** Auth, SSE, message persistence, retry semantics. We have most of this in `OllamaClient` already (`USE_OLLAMA_DIRECT=1` opt-in path) but only for blackboard's planner/auditor turns; the 9 runners' main prompts still go through opencode.
- **Re-doing multi-provider routing.** `Phase 1–4` of the multi-provider work goes THROUGH opencode (`@ai-sdk/anthropic` + `@ai-sdk/openai` packages declared in `opencode.json`). After E3 we'd talk to Anthropic / OpenAI APIs directly, mirroring what `OllamaClient` does today for Ollama. **This is the biggest piece of net-new work.**
- **Tool grants.** opencode's permission system (`swarm` / `swarm-read` / `swarm-builder` profiles) gates tool access. Workers depend on `*: deny`; planners depend on `read/grep/glob: allow`. Replacing this means owning a tool dispatcher (probably modeled on AI-SDK's tool spec).

## Concrete touchpoints (auto-inventoried 2026-04-29)

### `@opencode-ai/sdk` direct importers (must be replaced)

| File | What it does |
|---|---|
| `server/src/services/AgentManager.ts` | spawnAgent → `opencode serve` subprocess, session.create, session.prompt, event subscription, message routing |
| `server/src/services/RepoService.ts` | `writeOpencodeConfig` synthesizes per-clone `opencode.json` (provider blocks + agent profiles + MCP) |

### `OPENCODE_BIN` + spawn sites (deletable once AgentManager rewritten)

- `server/src/config.ts:63` — env-var declaration
- `server/src/services/AgentManager.ts:600,605` — the actual subprocess spawn

### `writeOpencodeConfig` callers (deletable once we own session config)

- `server/src/swarm/RoundRobinRunner.ts`
- `server/src/swarm/CouncilRunner.ts`
- `server/src/swarm/DebateJudgeRunner.ts`
- `server/src/swarm/MapReduceRunner.ts`
- `server/src/swarm/OrchestratorWorkerRunner.ts`
- `server/src/swarm/OrchestratorWorkerDeepRunner.ts`
- `server/src/swarm/StigmergyRunner.ts`
- `server/src/swarm/blackboard/BlackboardRunner.ts`
- `server/src/routes/dev.ts:108` — smoke test path
- (BaselineRunner already calls it but uses minimal config)

### `USE_OLLAMA_DIRECT` switch (the existing direct-path foundation)

- `server/src/swarm/promptWithRetry.ts:9,87,101,176` — opt-in routes prompts through `OllamaClient` instead of opencode session
- `server/src/swarm/SwarmRunner.ts:323` — runner config field
- `server/src/services/OllamaClient.ts` — the working direct-Ollama implementation we'll generalize

## Phased plan

### Phase 1 — Provider abstraction foundation (~1d)

**Goal:** one interface (`SessionProvider`) that encapsulates `chat(messages, opts) → AsyncIterable<chunk>`. Three impls land: `OllamaProvider` (wraps existing `OllamaClient`), `AnthropicProvider` (NEW, wraps `@ai-sdk/anthropic` directly), `OpenAIProvider` (NEW, wraps `@ai-sdk/openai`).

**Files:**
- `server/src/providers/SessionProvider.ts` (NEW) — interface
- `server/src/providers/OllamaProvider.ts` (NEW) — wraps `OllamaClient.chat`
- `server/src/providers/AnthropicProvider.ts` (NEW) — direct Anthropic SDK call
- `server/src/providers/OpenAIProvider.ts` (NEW) — direct OpenAI SDK call
- `server/src/providers/index.ts` (NEW) — `pickProvider(modelString)` factory using `detectProvider` from `shared/providers.ts`

**Checkpoint:** unit tests for each provider stub the underlying SDK and verify the chunked-iterator contract. No call sites change yet.

**Risk:** LOW — pure additions; nothing consumes the new interface until Phase 2.

### Phase 2 — Wire `USE_OLLAMA_DIRECT` for the 6 non-blackboard runners (~1d)

**Goal:** `promptWithRetry` already gates on `USE_OLLAMA_DIRECT` for blackboard's planner/auditor; extend to every preset's agent prompt path. This is incremental — the opencode subprocess still spawns, we just stop sending prompts through it when the flag is on.

**Files:**
- 6 runners (Council, RoundRobin, OrchestratorWorker, OrchestratorWorkerDeep, DebateJudge, MapReduce, Stigmergy) — replace direct `agent.client.session.prompt(...)` with `promptWithRetry`-equivalent pattern
- `BaselineRunner` — already uses `manager.streamPrompt` which goes through opencode; gate via the same flag

**Checkpoint:** 9 preset×Ollama runs with `USE_OLLAMA_DIRECT=1` produce equivalent output to the opencode path. Smoke them one preset at a time.

**Risk:** MEDIUM — different runners have slightly different prompt shapes; each migration is an opportunity for subtle bugs.

### Phase 3 — Replace `AgentManager.spawnAgent` with `Session` class (~3d)

**Goal:** stop spawning `opencode serve`. Instead, `AgentManager.spawnAgent` mints a lightweight `Session` object that holds: model, messages array, abort controller, per-agent state. No subprocess. Session.prompt fires through the Phase 1 `SessionProvider`.

**Files:**
- `server/src/services/AgentManager.ts` — gut + rewrite
- `server/src/services/Session.ts` (NEW) — replacement
- `server/src/services/PortAllocator.ts` — DELETE (no more port reservation needed)
- All callers of `agent.client.session.*` — port to the new `agent.session.*` shape

**Checkpoint:** every existing AgentManager test passes against the new Session shape (some need rewrites since they assert on subprocess behavior). Smoke run blackboard end-to-end.

**Risk:** HIGH — AgentManager is ~1700 LOC with many subtle behaviors (warmup, killAll, respawn, SSE reconnect, message dedupe). Plan to ship behind a `USE_SESSION_NO_OPENCODE=1` env flag for at least 5 stable runs before removing the opencode path.

### Phase 4 — Tool dispatcher (~2d)

**Goal:** opencode handles `read` / `grep` / `glob` / `list` / `bash` tool grants today. Workers (no tools) and discussion presets (read-only) and builders (bash) all rely on opencode's permission system. We need our own.

**Files:**
- `server/src/tools/ToolDispatcher.ts` (NEW) — given a profile name + a tool call, validate + execute
- `server/src/tools/profiles.ts` (NEW) — `swarm` / `swarm-read` / `swarm-builder` permission tables (mirror what's in `RepoService.writeOpencodeConfig` today)
- Each provider impl — register tool definitions in the AI-SDK call

**Checkpoint:** planner can grep + read in a real run via the new dispatcher.

**Risk:** MEDIUM — tool execution has security implications (especially `bash` for `swarm-builder`). Reuse the existing `buildCommandAllowlist.ts` for the bash gate.

### Phase 5 — Delete opencode dependency (~1d)

**Goal:** drop `@opencode-ai/sdk` from `server/package.json`, delete `opencode.json` synthesis, delete `OPENCODE_BIN` env var, update `README.md` Prerequisites section.

**Files:**
- `server/package.json` — remove the dep
- `server/src/services/RepoService.ts` — delete `writeOpencodeConfig` + all callers stop calling it
- `server/src/config.ts` — delete `OPENCODE_BIN`
- `README.md` — drop the "opencode CLI on PATH" line; keep "Ollama running" + add "or paste an API key"
- `docs/decisions/005-keep-opencode.md` — supersede with a "kept opencode for X duration, dropped on Y for Z reasons" ADR

**Checkpoint:** fresh install on a clean machine with only Ollama → `npm run dev` → fire a run → green.

**Risk:** LOW — at this point the dep is unused; removal is mechanical.

## Effort summary

| Phase | Effort | Risk |
|---|---|---|
| 1. Provider abstraction | ~1d | LOW |
| 2. Wire USE_OLLAMA_DIRECT for 6 runners | ~1d | MEDIUM |
| 3. Replace AgentManager.spawnAgent | ~3d | HIGH |
| 4. Tool dispatcher | ~2d | MEDIUM |
| 5. Delete opencode dependency | ~1d | LOW |
| **Total** | **~8d focused work** | — |

## Sequencing recommendations

- **Phase 1 first** because it's pure-add, low-risk, and unblocks Phase 2.
- **Phase 2 + Phase 4 can parallel** if two contributors are working — they touch different files.
- **Phase 3 must wait for Phase 1 + 2** — it depends on the provider abstraction AND requires the 6 runners to already work without opencode prompts.
- **Phase 5 only after** at least 5 stable runs with `USE_SESSION_NO_OPENCODE=1` against varied repos. Don't merge Phase 5 the same week Phase 3 lands.

## Pre-flight gates (must hold before touching Phase 3)

- 5+ stable blackboard runs with `USE_OLLAMA_DIRECT=1` (today: opt-in, untested at scale outside blackboard)
- Multi-provider live test: at least one Anthropic-keyed run completes through the existing opencode path so we have a reference for what "working" looks like before re-implementing it
- Provider abstraction (Phase 1) tests passing against stubbed SDKs

## What we keep from opencode after dropping it

The MCP integration (Playwright) is a real loss — opencode handles MCP server lifecycle for us. If we keep using Playwright MCP for UI verification (Unit 26), we'll need to spawn the MCP server ourselves and route tool calls through it. Acceptable cost; budget ~1d additional in Phase 4 for that.

The agent-profile / permission concept (`swarm` vs `swarm-read` vs `swarm-builder`) is also load-bearing — the tool dispatcher in Phase 4 must preserve it. Mirror the rules verbatim from today's `RepoService.writeOpencodeConfig`.

---

**Trigger to start:** explicit "begin E3 phase 1" once the pre-flight gates hold.
