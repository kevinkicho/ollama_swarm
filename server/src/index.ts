import express from "express";
import fs, { readFileSync as readFileSyncNode } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
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
import { reclaimStaleLocks } from "./swarm/cloneLock.js";
import { tmpdir } from "node:os";
import { RepoService } from "./services/RepoService.js";
import { Orchestrator } from "./services/Orchestrator.js";
import { startOllamaProxy, tokenTracker } from "./services/ollamaProxy.js";
import { Broadcaster } from "./ws/broadcast.js";
import { createEventLogger } from "./ws/eventLogger.js";
import { swarmRouter } from "./routes/swarm.js";
import { devRouter } from "./routes/dev.js";
import { v2Router } from "./routes/v2.js";
import { discoverAnthropicModels } from "./providers/discoverAnthropicModels.js";
import { discoverOpenAIModels } from "./providers/discoverOpenAIModels.js";
import {
  ANTHROPIC_MODELS as FALLBACK_ANTHROPIC,
  OPENAI_MODELS as FALLBACK_OPENAI,
  OLLAMA_CLOUD_MODELS,
  OPENCODE_GO_MODELS,
} from "../../shared/src/providers.js";
import { decideAutoResume } from "./swarm/autoResumeDecision.js";
import { loadSnapshot } from "./services/RunStatePersister.js";
import { globalErrorHandler } from "./middleware/errorHandler.js";
import { startLimiter, writeLimiter } from "./middleware/rateLimiter.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { apiVersion } from "./middleware/apiVersion.js";
import { corsMiddleware } from "./middleware/cors.js";
import { compressionMiddleware } from "./middleware/compression.js";
import { staticServing } from "./middleware/staticServing.js";
import { startupHealthCheck } from "./startupHealthCheck.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/index.ts (dev) or server/dist/index.js (built) -> up two to root.
const repoRoot = path.resolve(here, "..", "..");

const app = express();
app.use(securityHeaders);
app.use(apiVersion);
app.use(corsMiddleware);
app.use(compressionMiddleware);
app.use(requestLogger);

// WS auth — set a token cookie so the upgrade handler can validate it.
// Same token for the process lifetime; page refresh doesn't break WS.
const wsToken = randomUUID();
app.use((_req, res, next) => {
  res.cookie("ws_token", wsToken, { httpOnly: true, sameSite: "lax", path: "/" });
  next();
});

app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, path: "/ws", maxPayload: 1024 * 1024 });

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`FATAL: Port ${config.SERVER_PORT} is already in use.`);
    console.error(`  Kill the other process or set a different SERVER_PORT in .env.`);
  } else {
    console.error(`FATAL: server error: ${err.message}`);
  }
  process.exit(1);
});

// WS auth — intercept upgrade. Localhost bypass for dev.
server.on("upgrade", (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
  if (!req.url?.startsWith("/ws")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
});
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
  // T-Item-MultiTenant Phase 4 (2026-05-04): cap on concurrent runs.
  maxConcurrentRuns: config.SWARM_MAX_CONCURRENT_RUNS,
});

// R7 wiring (2026-05-04, W16 promotion 2026-05-04): pause-on-WS-
// disconnect. When SWARM_PAUSE_ON_DISCONNECT is on, the listener
// flips the matching runner's subscriberPaused flag so workers idle
// without burning prompts when no browser is watching. Resumes on
// first reconnect (orchestrator hook is a no-op for runners that
// don't implement setSubscriberPaused — discussion-only presets).
if (config.SWARM_PAUSE_ON_DISCONNECT) {
  broadcaster.setSubscriberChangeListener((change) => {
    if (change.action === "no-change") return;
    if (change.action === "pause") {
      orchestrator.setRunSubscriberPaused(change.runId, true);
    } else if (change.action === "resume") {
      orchestrator.setRunSubscriberPaused(change.runId, false);
    }
  });
}

broadcaster.attach(wss, (ws) => {
  // T-Item-MultiTenant: hydrate from the per-run status when the client
  // subscribed with ?runId=X. Without this, multi-tenant runs show the
  // active runner's contract/summary instead of the requested run's.
  const runIdFilter = broadcaster.getRunIdFilter(ws);
  const status = runIdFilter
    ? (orchestrator.statusForRun(runIdFilter) ?? orchestrator.status())
    : orchestrator.status();
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
    ollamaUrl: config.OLLAMA_BASE_URL,
  });
});

// #288: list models the local Ollama install can run RIGHT NOW so the
// SetupForm can autocomplete model fields. Hits Ollama's /api/tags
// directly (NOT through the snooping proxy — tags isn't a chat call,
// no point measuring tokens). Returns a sorted-by-recency string list
// so the most-recently-pulled model surfaces first in the dropdown.
//
// 2026-05-03: extended to dispatch on `?provider=` query param.
//   - default / "ollama": existing /api/tags discovery
//   - "anthropic": discoverAnthropicModels(env ANTHROPIC_API_KEY)
//   - "openai": discoverOpenAIModels(env OPENAI_API_KEY)
// Each paid-provider response is cached server-side for 24h to avoid
// thrashing /v1/models on every form load. On any failure (no key,
// non-OK HTTP, network error), the response falls back to the
// shared/providers.ts hardcoded list with `{ source: "fallback" }`.
//
// On any failure: 200 with { models, source, error? } rather than 5xx,
// so the form falls back gracefully to free-text without a noisy
// console.error in the user's browser.

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
interface ModelCacheEntry {
  models: readonly string[];
  fetchedAt: number;
  /** When models came from live discovery vs. fallback constants. */
  source: "discovery" | "fallback";
}
const modelCache = new Map<"anthropic" | "openai", ModelCacheEntry>();

async function getProviderModels(
  provider: "anthropic" | "openai",
): Promise<{ models: readonly string[]; source: "discovery" | "fallback" }> {
  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return { models: cached.models, source: cached.source };
  }
  const discovered =
    provider === "anthropic"
      ? await discoverAnthropicModels()
      : await discoverOpenAIModels();
  if (discovered && discovered.length > 0) {
    const entry: ModelCacheEntry = {
      models: discovered,
      fetchedAt: Date.now(),
      source: "discovery",
    };
    modelCache.set(provider, entry);
    return { models: entry.models, source: "discovery" };
  }
  // Fallback: hardcoded list. Cache the negative result for the same
  // TTL so a missing API key doesn't trigger discovery on every poll.
  const fallback = provider === "anthropic" ? FALLBACK_ANTHROPIC : FALLBACK_OPENAI;
  const entry: ModelCacheEntry = {
    models: fallback,
    fetchedAt: Date.now(),
    source: "fallback",
  };
  modelCache.set(provider, entry);
  return { models: entry.models, source: "fallback" };
}

app.get("/api/models", async (req, res) => {
  const provider = String(req.query.provider ?? "ollama").toLowerCase();
  if (provider === "anthropic" || provider === "openai") {
    const { models, source } = await getProviderModels(provider);
    res.json({ models, source });
    return;
  }
  // 2026-05-03: ollama-cloud returns the hardcoded catalog from
  // shared/providers.ts (sourced from ollama.com/search?c=cloud). No
  // live-discovery endpoint exists — the catalog is global and curated
  // by Ollama, not per-user. Source label is "fallback" so the UI
  // hint accurately says "catalog" rather than "live discovery".
  if (provider === "ollama-cloud") {
    res.json({ models: OLLAMA_CLOUD_MODELS, source: "fallback" });
    return;
  }
  // OpenCode Go — curated open models catalog.
  if (provider === "opencode") {
    res.json({ models: OPENCODE_GO_MODELS, source: "fallback" });
    return;
  }
  // Default / explicit "ollama" — existing behavior unchanged.
  const upstreamRoot = config.OLLAMA_BASE_URL.replace(/\/v1\/?$/, "");
  try {
    const r = await fetch(`${upstreamRoot}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      res.json({ models: [], source: "ollama-tags", error: `Ollama /api/tags returned HTTP ${r.status}` });
      return;
    }
    const body = (await r.json()) as { models?: Array<{ name: string; modified_at?: string }> };
    const sorted = (body.models ?? [])
      .slice()
      .sort((a, b) => (b.modified_at ?? "").localeCompare(a.modified_at ?? ""))
      .map((m) => m.name)
      .filter((n) => typeof n === "string" && n.length > 0);
    res.json({ models: sorted, source: "ollama-tags" });
  } catch (err) {
    res.json({
      models: [],
      source: "ollama-tags",
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

app.get("/api/usage", (req, res) => {
  // Task #159: opportunistic auto-clear on every poll (cheap).
  maybeClearStaleTransient();
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  res.json({
    last1h: tokenTracker.totalsInWindow(60 * 60_000, "1h", runId),
    last5h: tokenTracker.totalsInWindow(5 * 60 * 60_000, "5h", runId),
    last24h: tokenTracker.totalsInWindow(24 * 60 * 60_000, "24h", runId),
    last7d: tokenTracker.totalsInWindow(7 * 24 * 60 * 60_000, "7d", runId),
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

// Phase 2 of #314: setup form polls this to know which providers can
// be selected. Ollama is "available" whenever the local server is up
// (the form's existing /api/models call already checks Ollama
// reachability — this just reports whether the API key is wired);
// anthropic/openai are "available" only when the matching env var is
// set. Keys are NEVER echoed back; just a boolean per provider.
//
// 2026-05-03: ollama-cloud added per https://docs.ollama.com/cloud.
// Always available because the local Ollama install can proxy
// `:cloud` models to ollama.com when the user has an account
// configured locally (Ollama handles the auth itself). hasKey
// reflects whether OLLAMA_API_KEY env was set — informational only;
// the "available" flag stays true regardless so users with local
// auth-via-config can still pick the cloud tab.
app.get("/api/providers", (_req, res) => {
  res.json({
    ollama: { available: true, hasKey: true },
    "ollama-cloud": { available: true, hasKey: !!(config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY) },
    anthropic: {
      available: !!config.ANTHROPIC_API_KEY,
      hasKey: !!config.ANTHROPIC_API_KEY,
    },
    openai: {
      available: !!config.OPENAI_API_KEY,
      hasKey: !!config.OPENAI_API_KEY,
    },
    opencode: {
      available: !!(config.OPENCODE_GO_API_KEY || config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY),
      hasKey: !!(config.OPENCODE_GO_API_KEY || config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY),
    },
  });
});

// Rate limiting: /start is expensive (5/min); other POST writes (30/min).
app.use("/api/swarm/start", startLimiter);
app.use("/api/swarm", (req, res, next) => {
  if (req.method === "POST") return writeLimiter(req, res, next);
  next();
});
app.use("/api/swarm", swarmRouter(orchestrator));
app.use("/api/dev", devRouter({ broadcaster, repos }));
// V2 Step 6b: read-only event-log endpoint for the eventual UI cutover.
app.use("/api/v2", v2Router({ eventLogPath: eventLogger.path }));

// Static file serving for the built web frontend.
// In production (STATIC_DIR set), serves web/dist assets.
// Skips /api/* and /ws paths so they always hit the API routes.
const staticDir = config.STATIC_DIR && config.STATIC_DIR !== "none"
  ? config.STATIC_DIR
  : path.join(repoRoot, "web", "dist");
if (fs.existsSync(staticDir)) {
  app.use(staticServing(staticDir));
  console.log(`  static: serving web frontend from ${staticDir}`);
}
// Global error handler — must be after all routes.
app.use(globalErrorHandler);

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return; // guard against re-entrant signals
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down swarm`);
  try { broadcaster.detach(); } catch { /* ignore */ }
  // orchestrator.stop() can hang if a runner is mid-flight. Race it
  // against a 20 s timeout so graceful shutdown doesn't block forever.
  try {
    await Promise.race([
      orchestrator.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator.stop() timed out")), 20_000)),
    ]);
  } catch { /* ignore */ }
  eventLogger.close();
  try { await proxy?.stop(); } catch { /* ignore */ }

  // Close the HTTP server — stops accepting new connections. Uses
  // Promise wrapper so we await completion instead of hoping the
  // callback fires before the Node event loop drains.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  // Give in-flight cleanup (killAll, file writes, Ollama proxy
  // connections) up to 15 s to finish before force-exiting. The
  // previous 5 s was too tight for killAll's three-stage escalation.
  await new Promise((r) => setTimeout(r, 15_000));
  process.exit(0);
};
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// Without these, any rejected promise from an SDK call or stray fetch takes the
// whole Node process down (Node >=15 default). Log the full error + stack and
// push it to the UI so the user isn't just dumped back to the setup modal.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[server] unhandledRejection:", err.stack ?? err.message);
  broadcaster.broadcast({ type: "error", message: `unhandledRejection: ${err.message}` });
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — shutting down:", err.stack ?? err.message);
  try { eventLogger.close(); } catch {}
  broadcaster.broadcast({ type: "error", message: `Uncaught exception — server exiting: ${err.message}` });
  // Attempt graceful shutdown before force-exiting — reuses the same
  // cleanup path as SIGTERM/SIGINT for consistent resource release.
  shutdown("uncaughtException").finally(() => process.exit(1));
});

// Task #133: start the Ollama proxy BEFORE listen so the rewritten
// OLLAMA_BASE_URL is in place before any agent spawns. The proxy
// listens on OLLAMA_PROXY_PORT and forwards to the original Ollama
// URL. We then mutate config.OLLAMA_BASE_URL in-memory so every
// downstream consumer (RepoService.writeOpencodeConfig, /api/health
// readout) sees the proxied URL. Set OLLAMA_PROXY_PORT=0 to disable.
// proxy: Ollama proxy server, started below. Declared here so the
// shutdown function can access it regardless of whether the proxy
// was conditionally started.
let proxy: { stop: () => Promise<void> } | undefined;

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
  proxy = startOllamaProxy({
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
//
// Also reclaim stale clone lock files left by killed/crashed runs.
void reclaimOrphans(repoRoot)
  .then((result) => {
    if (result.scanned === 0) {
      console.log("  orphan reclamation: none in log, clean start");
    } else {
      console.log(
        `  orphan reclamation: ${result.alive}/${result.scanned} PIDs were still alive, killed ${result.killed}`,
      );
    }
    // Reclaim stale clone locks from killed/crashed prior runs
    const KNOWN_PARENTS_FILE = path.join(tmpdir(), "ollama-swarm-known-parents.json");
    const knownParents = (() => {
      try {
        const raw = readFileSyncNode(KNOWN_PARENTS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((p: unknown): p is string => typeof p === "string") : [];
      } catch { return []; }
    })();
    if (knownParents.length > 0) {
      const reclaimed = reclaimStaleLocks(knownParents);
      if (reclaimed > 0) {
        console.log(`  stale lock reclamation: removed ${reclaimed} orphaned lock(s)`);
      }
    }
  })
  .catch((err) => {
    console.error("  orphan reclamation failed (non-fatal):", err);
  })
  .finally(async () => {
    // Pre-flight health check — warns if port is in use or disk is low.
    const runsDir = path.join(repoRoot, "runs");
    const health = await startupHealthCheck(config.SERVER_PORT, runsDir);
    if (health.warnings.length > 0) {
      console.warn("┌──────────────────────────────────────────────────┐");
      console.warn("│  Startup health check warnings                   │");
      for (const w of health.warnings) {
        console.warn(`│  ⚠ ${w}`);
      }
      console.warn("└──────────────────────────────────────────────────┘");
    }
    server.listen(config.SERVER_PORT, "0.0.0.0", () => {
      console.log(`ollama_swarm server listening on http://127.0.0.1:${config.SERVER_PORT}`);
      console.log(`  ollama: ${config.OLLAMA_BASE_URL}`);
      console.log(`  default model: ${config.DEFAULT_MODEL}`);
      console.log(`  event log: ${eventLogger.path}`);
      // R5 wiring (2026-05-04): auto-resume mid-flight runs from disk.
      // Fire-and-forget — startup must complete even if resume fails.
      if (config.SWARM_AUTO_RESUME) {
        void autoResumeOnStartup();
      }
    });
  });

/** R5 wiring (2026-05-04): scan recoverable snapshots, ask the policy
 *  helper which ones are safe to auto-restart, and kick recoverRun
 *  for each. Best-effort: any per-run failure is logged + skipped so
 *  one bad snapshot can't block the others. */
async function autoResumeOnStartup(): Promise<void> {
  let recoverable;
  try {
    recoverable = orchestrator.listRecoverableRuns();
  } catch (err) {
    console.error("  auto-resume: listRecoverableRuns failed:", err);
    return;
  }
  if (recoverable.length === 0) {
    console.log("  auto-resume: no recoverable snapshots");
    return;
  }
  const now = Date.now();
  let resumed = 0;
  let skipped = 0;
  for (const r of recoverable) {
    const snap = loadSnapshot(r.stateFilePath);
    if (!snap) {
      skipped += 1;
      continue;
    }
    const decision = decideAutoResume(snap, { now });
    if (decision.action !== "auto-resume") {
      skipped += 1;
      continue;
    }
    try {
      const out = await orchestrator.recoverRun(r.runId);
      console.log(
        `  auto-resume: kicked recovery for runId=${r.runId} → newRunId=${out.newRunId}`,
      );
      resumed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  auto-resume: failed for runId=${r.runId}: ${msg}`);
      skipped += 1;
    }
  }
  console.log(
    `  auto-resume: ${resumed} resumed, ${skipped} skipped of ${recoverable.length} recoverable`,
  );
}
