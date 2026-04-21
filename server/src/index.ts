import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { AgentManager } from "./services/AgentManager.js";
import { RepoService } from "./services/RepoService.js";
import { Orchestrator } from "./services/Orchestrator.js";
import { Broadcaster } from "./ws/broadcast.js";
import { swarmRouter } from "./routes/swarm.js";
import { devRouter } from "./routes/dev.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const broadcaster = new Broadcaster();

const manager = new AgentManager(
  (s) => broadcaster.broadcast({ type: "agent_state", agent: s }),
  (e) => broadcaster.broadcast(e),
);
const repos = new RepoService();
const orchestrator = new Orchestrator({
  manager,
  repos,
  emit: (e) => broadcaster.broadcast(e),
});

broadcaster.attach(wss, (ws) => {
  // Send current status snapshot so new clients are caught up immediately.
  const status = orchestrator.status();
  broadcaster.send(ws, { type: "swarm_state", phase: status.phase, round: status.round });
  for (const a of status.agents) broadcaster.send(ws, { type: "agent_state", agent: a });
  for (const entry of status.transcript) broadcaster.send(ws, { type: "transcript_append", entry });
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
});
