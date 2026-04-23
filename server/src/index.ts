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
import { RepoService } from "./services/RepoService.js";
import { Orchestrator } from "./services/Orchestrator.js";
import { Broadcaster } from "./ws/broadcast.js";
import { createEventLogger } from "./ws/eventLogger.js";
import { swarmRouter } from "./routes/swarm.js";
import { devRouter } from "./routes/dev.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/index.ts (dev) or server/dist/index.js (built) -> up two to root.
const repoRoot = path.resolve(here, "..", "..");

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const eventLogger = createEventLogger({ logDir: path.join(repoRoot, "logs") });
const broadcaster = new Broadcaster(eventLogger);

const manager = new AgentManager(
  (s) => broadcaster.broadcast({ type: "agent_state", agent: s }),
  (e) => broadcaster.broadcast(e),
  // Diagnostic-only sink: opencode stdout/stderr + raw SSE envelope records
  // go straight to the JSONL log without hitting the WS stream.
  (rec) => eventLogger.log(rec),
);
const repos = new RepoService();
const orchestrator = new Orchestrator({
  manager,
  repos,
  emit: (e) => broadcaster.broadcast(e),
  // Unit 19: per-call timing telemetry from promptWithRetry lands here
  // (alongside the AgentManager's diag records). Same logs/current.jsonl.
  logDiag: (rec) => eventLogger.log(rec),
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

app.use("/api/swarm", swarmRouter(orchestrator));
app.use("/api/dev", devRouter(broadcaster));

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

server.listen(config.SERVER_PORT, () => {
  console.log(`ollama_swarm server listening on http://127.0.0.1:${config.SERVER_PORT}`);
  console.log(`  orchestrator opencode: ${config.OPENCODE_BASE_URL}`);
  console.log(`  ollama: ${config.OLLAMA_BASE_URL}`);
  console.log(`  default model: ${config.DEFAULT_MODEL}`);
  console.log(`  event log: ${eventLogger.path}`);
});
