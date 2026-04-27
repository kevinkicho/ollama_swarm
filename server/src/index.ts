import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { configureHttpDispatcher } from "./services/httpDispatcher.js";

// Install the bounded undici dispatcher BEFORE any import that might trigger
// a fetch (e.g. SDK client construction at AgentManager spawn-time). Has to
// run in the module-loading phase, not behind async setup.
configureHttpDispatcher();

import { config } from "./config.js";
import { AgentManager } from "./services/AgentManager.js";
import { AgentPidTracker } from "./services/agentPids.js";
import { reclaimOrphans } from "./services/reclaimOrphans.js";
import { RepoService } from "./services/RepoService.js";
import { Orchestrator } from "./services/Orchestrator.js";
import { startOllamaProxy, tokenTracker } from "./services/ollamaProxy.js";
import { Broadcaster } from "./ws/broadcast.js";
import { createEventLogger } from "./ws/eventLogger.js";
import { swarmRouter } from "./routes/swarm.js";
import { devRouter } from "./routes/dev.js";
import { v2Router } from "./routes/v2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/index.ts (dev) or server/dist/index.js (built) -> up two to root.
const repoRoot = path.resolve(here, "..", "..");

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const eventLogger = createEventLogger({ logDir: path.join(repoRoot, "logs") });
const broadcaster = new Broadcaster(eventLogger);

// Unit 38: shared PID tracker for orphan reclamation across dev-server
// restarts. Writes to `<repoRoot>/logs/agent-pids.log`. AgentManager
// appends per spawn + removes per clean exit; reclaimOrphans (below)
// reads it on startup to kill untracked live PIDs from previous runs.
const pidTracker = new AgentPidTracker(repoRoot);

const manager = new AgentManager(
  (s) => broadcaster.broadcast({ type: "agent_state", agent: s }),
  (e) => broadcaster.broadcast(e),
  // Diagnostic-only sink: opencode stdout/stderr + raw SSE envelope records
  // go straight to the JSONL log without hitting the WS stream.
  (rec) => eventLogger.log(rec),
  pidTracker,
);
const repos = new RepoService();
const orchestrator = new Orchestrator({
  manager,
  repos,
  emit: (e) => broadcaster.broadcast(e),
  // Unit 19: per-call timing telemetry from promptWithRetry lands here
  // (alongside the AgentManager's diag records). Same logs/current.jsonl.
  logDiag: (rec) => eventLogger.log(rec),
  // V2 Step 1: Ollama base URL (proxy-aware) for the Ollama-direct
  // path. Strip /v1 suffix so OllamaClient can append /api/chat.
  ollamaBaseUrl: config.OLLAMA_BASE_URL.replace(/\/v1\/?$/, ""),
});

broadcaster.attach(wss, (ws) => {
  // Send current status snapshot so new clients are caught up immediately.
  const status = orchestrator.status();
  broadcaster.send(ws, { type: "swarm_state", phase: status.phase, round: status.round });
  for (const a of status.agents) broadcaster.send(ws, { type: "agent_state", agent: a });
  for (const entry of status.transcript) broadcaster.send(ws, { type: "transcript_append", entry });
  // Replay contract + summary for reloads of a completed run. Both events only
  // fire once over the live socket, so without this a page refresh after a
  // terminal run would show empty Contract and Summary cards.
  if (status.contract) broadcaster.send(ws, { type: "contract_updated", contract: status.contract });
  if (status.summary) broadcaster.send(ws, { type: "run_summary", summary: status.summary });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    defaultModel: config.DEFAULT_MODEL,
    orchestratorUrl: config.OPENCODE_BASE_URL,
    ollamaUrl: config.OLLAMA_BASE_URL,
  });
});

// Task #133: token-usage endpoint backed by the Ollama proxy. Returns
// per-window aggregates derived from prompt_eval_count + eval_count
// captured on every Ollama response. Empty when proxy is disabled
// (OLLAMA_PROXY_PORT=0).
// Task #159: auto-clear transient quota flags after STALE_TRANSIENT_MS
// of no new wall observation. Concurrency-429s clear in seconds upstream;
// keeping the flag set indefinitely misleads users into thinking they're
// near a usage limit. Persistent walls (real plan/quota limit) stay set
// until explicit clear (Orchestrator.start clears on each new run).
const STALE_TRANSIENT_MS = 5 * 60_000;
function maybeClearStaleTransient(): void {
  const q = tokenTracker.getQuotaState();
  if (q && q.kind === "transient" && Date.now() - q.since > STALE_TRANSIENT_MS) {
    tokenTracker.clearQuotaState();
  }
}

app.get("/api/usage", (_req, res) => {
  // Task #159: opportunistic auto-clear on every poll (cheap).
  maybeClearStaleTransient();
  res.json({
    last1h: tokenTracker.totalsInWindow(60 * 60_000, "1h"),
    last5h: tokenTracker.totalsInWindow(5 * 60 * 60_000, "5h"),
    last24h: tokenTracker.totalsInWindow(24 * 60 * 60_000, "24h"),
    last7d: tokenTracker.totalsInWindow(7 * 24 * 60 * 60_000, "7d"),
    lifetime: tokenTracker.total(),
    // Task #169: lifetime breakdown (byModel + byPreset) for the
    // UsageWidget's All-time toggle. Same shape as the windowed
    // entries; client picks whichever the user toggled to.
    lifetimeWindow: tokenTracker.totalsAllTime("lifetime"),
    recent: tokenTracker.recent(50),
    // Task #137: surface the quota-exhausted state so polling clients
    // (3-min usage check, UI dashboard, the smoke-tour script) can
    // see the wall as soon as the proxy detects it. Null when no wall
    // observed since the last clearQuotaState() (i.e. since the
    // current run started).
    quota: tokenTracker.getQuotaState(),
  });
});

// Task #159: explicit dismiss endpoint. Lets the UI's "Dismiss" button
// clear a stale flag without requiring a new run. Idempotent — clearing
// when nothing's set is a no-op.
app.post("/api/usage/clear-quota", (_req, res) => {
  tokenTracker.clearQuotaState();
  res.json({ ok: true });
});

app.use("/api/swarm", swarmRouter(orchestrator));
app.use("/api/dev", devRouter({ broadcaster, repos }));
// V2 Step 6b: read-only event-log endpoint for the eventual UI cutover.
app.use("/api/v2", v2Router({ eventLogPath: eventLogger.path }));

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received — shutting down swarm`);
  try {
    await orchestrator.stop();
  } catch {
    // ignore
  }
  eventLogger.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Without these, any rejected promise from an SDK call or stray fetch takes the
// whole Node process down (Node >=15 default). Log the full error + stack and
// push it to the UI so the user isn't just dumped back to the setup modal.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[server] unhandledRejection:", err.stack ?? err.message);
  broadcaster.broadcast({ type: "error", message: `unhandledRejection: ${err.message}` });
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err.stack ?? err.message);
  broadcaster.broadcast({ type: "error", message: `uncaughtException: ${err.message}` });
});

// Task #133: start the Ollama proxy BEFORE listen so the rewritten
// OLLAMA_BASE_URL is in place before any agent spawns. The proxy
// listens on OLLAMA_PROXY_PORT and forwards to the original Ollama
// URL. We then mutate config.OLLAMA_BASE_URL in-memory so every
// downstream consumer (RepoService.writeOpencodeConfig, /api/health
// readout) sees the proxied URL. Set OLLAMA_PROXY_PORT=0 to disable.
if (config.OLLAMA_PROXY_PORT > 0) {
  const upstreamUrl = config.OLLAMA_BASE_URL;
  // Strip /v1 suffix if present — proxy needs the host:port root so it
  // can forward both /api/* and /v1/* paths verbatim.
  const upstreamRoot = upstreamUrl.replace(/\/v1\/?$/, "");
  const proxyHost = `http://127.0.0.1:${config.OLLAMA_PROXY_PORT}`;
  // 2026-04-27: ALWAYS terminate the rewritten URL with /v1. opencode's
  // openai-compatible adapter (RepoService writes this to opencode.json's
  // provider.options.baseURL) appends `/chat/completions` directly, so
  // a baseURL without /v1 → opencode hits `/chat/completions` → 404.
  // V2 OllamaClient strips /v1 and uses /api/chat, so it's unaffected.
  // Pre-fix: this mirrored whatever the user provided, so an env var of
  // OLLAMA_BASE_URL=http://localhost:11434 (no /v1) silently broke
  // every opencode-routed prompt with empty responses.
  const proxyUrlWithSuffix = `${proxyHost}/v1`;
  startOllamaProxy({
    listenPort: config.OLLAMA_PROXY_PORT,
    upstreamUrl: upstreamRoot,
  });
  // Rewrite in-memory config so downstream consumers see the proxy URL.
  (config as { OLLAMA_BASE_URL: string }).OLLAMA_BASE_URL = proxyUrlWithSuffix;
  console.log(`  ollama proxy: ${proxyHost} → ${upstreamRoot} (token capture enabled)`);
}

// Unit 38: reclaim orphaned opencode subprocesses from prior server
// instances BEFORE we start accepting swarm-start requests. This
// prevents the PortAllocator from handing out a port that a zombie
// process still holds, and bounds cumulative resource leak across
// dev-server restarts. Await so listen doesn't race the kill.
void reclaimOrphans(repoRoot)
  .then((result) => {
    if (result.scanned === 0) {
      console.log("  orphan reclamation: none in log, clean start");
    } else {
      console.log(
        `  orphan reclamation: ${result.alive}/${result.scanned} PIDs were still alive, killed ${result.killed}`,
      );
    }
  })
  .catch((err) => {
    console.error("  orphan reclamation failed (non-fatal):", err);
  })
  .finally(() => {
    server.listen(config.SERVER_PORT, () => {
      console.log(`ollama_swarm server listening on http://127.0.0.1:${config.SERVER_PORT}`);
      console.log(`  orchestrator opencode: ${config.OPENCODE_BASE_URL}`);
      console.log(`  ollama: ${config.OLLAMA_BASE_URL}`);
      console.log(`  default model: ${config.DEFAULT_MODEL}`);
      console.log(`  event log: ${eventLogger.path}`);
    });
  });
