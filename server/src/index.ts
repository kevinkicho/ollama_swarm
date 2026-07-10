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
import { rootLogger } from "./services/logger.js";
import { RunEventHub, createBroadcasterSink, createEventLoggerSink, createDebugSink } from "./services/RunEventHub.js";
import { swarmRouter } from "./routes/swarm.js";
import { devRouter } from "./routes/dev.js";
import { v2Router } from "./routes/v2.js";
import { discoverAnthropicModels } from "./providers/discoverAnthropicModels.js";
import { discoverOpenAIModels } from "./providers/discoverOpenAIModels.js";
import { discoverOpenCodeModels } from "./providers/discoverOpenCodeModels.js";
import {
  getSystemLayerSettingsPayload,
  resolveSystemLayerModel,
  setSystemLayerUiModel,
} from "./services/systemLayerSettings.js";
import {
  ANTHROPIC_MODELS as FALLBACK_ANTHROPIC,
  OPENAI_MODELS as FALLBACK_OPENAI,
  OLLAMA_CLOUD_MODELS,
  OPENCODE_GO_MODELS,
} from "@ollama-swarm/shared/providers";
import type { SwarmEvent } from "./types.js";
import { providerGateway } from "./providers/ProviderGateway.js";
import {
  getProvidersApiResponse,
  getProvidersStatusPayload,
  probeProviders,
  startProviderHealthScheduler,
  stopProviderHealthScheduler,
} from "./providers/providerHealth.js";
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
import { apiAuthMiddleware, isInsecureLanExposure } from "./middleware/apiAuth.js";
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

// Lightweight liveness (open even when SWARM_API_TOKEN is set).
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, host: config.SERVER_HOST, port: config.SERVER_PORT });
});

// Optional API token gate for all other /api routes.
app.use("/api", apiAuthMiddleware);

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

function parseCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}

function isLocalWsClient(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

// WS auth — cookie for remote clients; optional SWARM_API_TOKEN for all clients
// when configured (secure appliance mode). Localhost may omit cookie only when
// API token is not set.
server.on("upgrade", (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
  if (!req.url?.startsWith("/ws")) { socket.destroy(); return; }
  const apiToken = config.SWARM_API_TOKEN;
  if (apiToken) {
    const q = new URL(req.url, "http://localhost").searchParams.get("token");
    const headerTok =
      (typeof req.headers["x-swarm-token"] === "string" ? req.headers["x-swarm-token"] : undefined) ??
      parseCookieValue(req.headers.cookie, "swarm_api_token");
    const bearer = (() => {
      const a = req.headers.authorization;
      if (typeof a !== "string") return undefined;
      const m = /^Bearer\s+(.+)$/i.exec(a.trim());
      return m?.[1]?.trim();
    })();
    if (q !== apiToken && headerTok !== apiToken && bearer !== apiToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  } else if (!isLocalWsClient(req)) {
    const token = parseCookieValue(req.headers.cookie, "ws_token");
    if (token !== wsToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
});
const eventLogger = createEventLogger({ logDir: config.LOG_DIR ?? path.join(repoRoot, "logs") });
const broadcaster = new Broadcaster(eventLogger);

// Logging / history / debug pipes (organized by functionality):
// - Broadcaster + WS: real-time live updates to connected UIs (per-run filtered for multi-tenant)
// - EventLogger (JSONL): persistent audit + cross-session history for /api/v2/event-log and UI history panels
// - Transcript + status snapshots: in-memory + persister for UI hydrate and recovery
// - logDiag: diagnostic records (token, errors, etc) routed to event log
// - rootLogger / structured logs: server-side debug with runId/reqId correlation
// Goal: reduce ad-hoc console.* and unify emission points by category (lifecycle, agent, brain, diag, usage).

// PID tracker for orphan process reclamation (across restarts).
const pidTracker = new AgentPidTracker(repoRoot);

function createAgentManager(runId: string): AgentManager {
  // Per-run hub to organize pipes (realtime, persistent history, debug).
  // This replaces direct broadcaster + eventLogger calls for better organization.
  const hub = new RunEventHub({ runId });
  hub.registerSink(createBroadcasterSink(broadcaster));
  hub.registerSink(createEventLoggerSink(eventLogger));
  // Debug sink for per-run categorized debug file
  hub.registerSink(createDebugSink(runId, config.LOG_DIR ?? path.join(repoRoot, "logs")));

  return new AgentManager(
    (s) => hub.emitAgent({ type: "agent_state", agent: s }),
    (e) => hub.emit({ ...(e.runId === undefined ? { ...e, runId } : e) }),
    // Diagnostic records still go to persistent log (via hub or direct for now).
    (rec) => eventLogger.log(rec),
    pidTracker,
  );
}
const repos = new RepoService();
const orchestrator = new Orchestrator({
  createManager: createAgentManager,
  repos,
  // Emit now goes through per-run hubs created in createAgentManager for unified pipes.
  emit: (e) => broadcaster.broadcast(e),
  logDiag: (rec) => eventLogger.log(rec),
  // V2 Step 1: Ollama base URL (proxy-aware) for the Ollama-direct
  // path. Strip /v1 suffix so OllamaClient can append /api/chat.
  ollamaBaseUrl: config.OLLAMA_BASE_URL.replace(/\/v1\/?$/, ""),
  maxConcurrentRuns: config.SWARM_MAX_CONCURRENT_RUNS,
});

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
  const liveStatus = runIdFilter ? orchestrator.statusForRun(runIdFilter) : null;
  const status = liveStatus || {
    // For a specific historical run (e.g. finished blackboard with no live .run-state
    // snapshot for that exact runId because same-clone runs overwrite it), do NOT
    // fall back to the global active status() — that would stamp the wrong run's
    // phase/agents into the per-run WS view and make /runs/:id show the setup page.
    // Send a minimal terminal placeholder (not "idle") so the route-based /runs/:id
    // view stays on SwarmView instead of flipping to the "start a swarm" SetupForm.
    // The client's per-run hydrate (via /runs list + /run-summary) + transcript replay
    // will populate the real data (agents, full transcript, summary grid).
    phase: "stopped" as any,
    round: 0,
    agents: [],
    transcript: [],
    runId: runIdFilter || undefined,
  } as any;
  const hydrateRunId = runIdFilter ?? status.runId;
  const stamp = <T extends SwarmEvent>(e: T): T =>
    hydrateRunId && e.runId === undefined ? { ...e, runId: hydrateRunId } : e;
  broadcaster.send(ws, stamp({ type: "swarm_state", phase: status.phase, round: status.round }));
  for (const a of status.agents) broadcaster.send(ws, stamp({ type: "agent_state", agent: a }));
  for (const entry of status.transcript) broadcaster.send(ws, stamp({ type: "transcript_append", entry }));
  // Replay contract + summary for reloads of a completed run. Both events only
  // fire once over the live socket, so without this a page refresh after a
  // terminal run would show empty Contract and Summary cards.
  if (status.contract) broadcaster.send(ws, stamp({ type: "contract_updated", contract: status.contract }));
  if (status.summary) broadcaster.send(ws, stamp({ type: "run_summary", summary: status.summary }));
});

app.get("/api/health", (_req, res) => {
  const providersPayload = getProvidersStatusPayload();
  const ollamaProbe = providersPayload.providers.ollama;
  const systemLayer = resolveSystemLayerModel();
  const activeProbe = providersPayload.providers[systemLayer.provider];
  const activeOk =
    activeProbe.probeStatus === "ok" ||
    activeProbe.probeStatus === "degraded" ||
    activeProbe.probeStatus === "idle";
  res.json({
    ok: activeOk,
    model: systemLayer.modelString,
    provider: systemLayer.provider,
    toolsEnabled: systemLayer.toolsEnabled,
    probe: {
      status: activeProbe.probeStatus,
      lastProbeAt: activeProbe.lastProbeAt,
      lastProbeMs: activeProbe.lastProbeMs,
      lastError: activeProbe.lastError,
      modelCount: activeProbe.modelCount,
    },
    defaultModel: config.DEFAULT_MODEL,
    systemLayerModel: systemLayer.modelString,
    systemLayerProvider: systemLayer.provider,
    systemLayerTools: systemLayer.toolsEnabled,
    systemLayerSource: systemLayer.source,
    ollamaUrl: config.OLLAMA_BASE_URL,
    ollamaProbe: {
      status: ollamaProbe.probeStatus,
      lastProbeAt: ollamaProbe.lastProbeAt,
      lastProbeMs: ollamaProbe.lastProbeMs,
      lastError: ollamaProbe.lastError,
      modelCount: ollamaProbe.modelCount,
    },
  });
});

app.get("/api/system-layer", (_req, res) => {
  res.json(getSystemLayerSettingsPayload());
});

app.put("/api/system-layer", (req, res) => {
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (!model || model.length > 200) {
    res.status(400).json({ error: "model string required (max 200 chars)" });
    return;
  }
  setSystemLayerUiModel(model);
  res.json(getSystemLayerSettingsPayload());
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
const modelCache = new Map<"anthropic" | "openai" | "opencode", ModelCacheEntry>();

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
  if (provider === "opencode") {
    const cached = modelCache.get("opencode");
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
      res.json({ models: cached.models, source: cached.source });
      return;
    }
    const goKey = config.OPENCODE_GO_API_KEY || config.OPENCODE_API_KEY;
    const zenKey = config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY;
    const discovered = await discoverOpenCodeModels({ goApiKey: goKey, zenApiKey: zenKey });
    if (discovered && discovered.length > 0) {
      const entry: ModelCacheEntry = {
        models: discovered,
        fetchedAt: Date.now(),
        source: "discovery",
      };
      modelCache.set("opencode", entry);
      res.json({ models: entry.models, source: "discovery" });
      return;
    }
    const entry: ModelCacheEntry = {
      models: OPENCODE_GO_MODELS,
      fetchedAt: Date.now(),
      source: "fallback",
    };
    modelCache.set("opencode", entry);
    res.json({ models: entry.models, source: "fallback" });
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

// Token usage endpoint (backed by Ollama proxy). Returns
// per-window aggregates derived from prompt_eval_count + eval_count
// captured on every Ollama response. Empty when proxy is disabled
// (OLLAMA_PROXY_PORT=0).
// Auto-clear transient quota flags after timeout
// of no new wall observation. Concurrency-429s clear in seconds upstream;
// keeping the flag set indefinitely misleads users into thinking they're
// near a usage limit. Persistent walls (real plan/quota limit) stay set
// until explicit clear (Orchestrator.start clears on each new run).
const STALE_TRANSIENT_MS = 5 * 60_000;
function maybeClearStaleTransient(runId?: string): void {
  const q = tokenTracker.getQuotaState(runId);
  if (q && q.kind === "transient" && Date.now() - q.since > STALE_TRANSIENT_MS) {
    if (runId) tokenTracker.clearQuotaState(runId);
    else tokenTracker.clearQuotaState();
  }
}

app.get("/api/usage", (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  // Task #159: opportunistic auto-clear on every poll (cheap).
  maybeClearStaleTransient(runId);
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
    quota: tokenTracker.getQuotaState(runId),
    globalQuota: tokenTracker.getGlobalQuotaState(),
    proxyPressure: tokenTracker.pressure ? tokenTracker.pressure() : null,
  });
});

// Task #159: explicit dismiss endpoint. Lets the UI's "Dismiss" button
// clear a stale flag without requiring a new run. Idempotent — clearing
// when nothing's set is a no-op.
app.post("/api/usage/clear-quota", (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
  if (runId) tokenTracker.clearQuotaState(runId);
  else tokenTracker.clearQuotaState();
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
app.get("/api/providers/health", (_req, res) => {
  const body = getProvidersApiResponse();
  res.json(body.gateway);
});

app.get("/api/providers", (_req, res) => {
  res.json(getProvidersApiResponse());
});

app.post("/api/providers/probe", async (req, res) => {
  const providers = Array.isArray(req.body?.providers)
    ? (req.body.providers as string[]).filter((p): p is import("@ollama-swarm/shared/providers").Provider =>
        ["ollama", "ollama-cloud", "anthropic", "openai", "opencode"].includes(p),
      )
    : undefined;
  const force = req.body?.force === true;
  try {
    const payload = await probeProviders({ providers, force });
    res.json(payload);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  rootLogger.info(`static: serving web frontend from ${staticDir}`);
}
// Global error handler — must be after all routes.
app.use(globalErrorHandler);

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return; // guard against re-entrant signals
  shuttingDown = true;
  rootLogger.info(`${signal} received — shutting down swarm`);
  try { broadcaster.detach(); } catch { /* ignore */ }

  // tsx watch sends SIGTERM and immediately spawns a replacement — release
  // the TCP port first so the new process can bind without EADDRINUSE.
  const fastExit = signal === "SIGTERM";
  try { wss.close(); } catch { /* ignore */ }
  await new Promise<void>((resolve) => {
    try {
      server.closeAllConnections?.();
    } catch { /* ignore */ }
    server.close(() => resolve());
    setTimeout(resolve, fastExit ? 400 : 5_000).unref?.();
  });

  // Best-effort runner cleanup after the port is free.
  const stopBudgetMs = fastExit ? 3_000 : 20_000;
  try {
    await Promise.race([
      orchestrator.stopAll(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator.stopAll() timed out")), stopBudgetMs)),
    ]);
  } catch { /* ignore */ }
  stopProviderHealthScheduler();
  eventLogger.close();
  try { await proxy?.stop(); } catch { /* ignore */ }

  if (!fastExit) {
    // Interactive stop (SIGINT): brief tail for killAll file writes.
    await new Promise((r) => setTimeout(r, 2_000));
  }
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

// Start Ollama proxy before listen (rewritten URL)
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

// Reclaim orphaned processes from prior runs (if any)
// instances BEFORE we start accepting swarm-start requests. This
// bounds cumulative resource leak across dev-server restarts.
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
    const logsDir = path.join(repoRoot, "logs");
    await orchestrator.whenBrainReady();
    const health = await startupHealthCheck(config.SERVER_PORT, logsDir);
    if (health.warnings.length > 0) {
      console.warn("┌──────────────────────────────────────────────────┐");
      console.warn("│  Startup health check warnings                   │");
      for (const w of health.warnings) {
        console.warn(`│  ⚠ ${w}`);
      }
      console.warn("└──────────────────────────────────────────────────┘");
    }
    const listenHost = config.SERVER_HOST;
    server.listen(config.SERVER_PORT, listenHost, () => {
      startProviderHealthScheduler();
      console.log(`ollama_swarm server listening on http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${config.SERVER_PORT} (bind ${listenHost})`);
      console.log(`  ollama: ${config.OLLAMA_BASE_URL}`);
      console.log(`  default model: ${config.DEFAULT_MODEL}`);
      console.log(`  event log: ${eventLogger.path}`);
      console.log(`  api auth: ${config.SWARM_API_TOKEN ? "token required" : "open (local trusted)"}`);
      console.log(`  mcp servers: ${config.SWARM_ALLOW_MCP_SERVERS ? "allowed" : "disabled"}`);
      if (isInsecureLanExposure()) {
        console.warn("⚠ SECURITY: SERVER_HOST is not loopback and SWARM_API_TOKEN is unset.");
        console.warn("  Anyone on the network can start runs and use provider keys. Set SWARM_API_TOKEN or bind 127.0.0.1.");
      }
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
