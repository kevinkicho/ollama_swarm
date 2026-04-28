import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { Broadcaster } from "../ws/broadcast.js";
import { Board } from "../swarm/blackboard/Board.js";
import { createBoardBroadcaster } from "../swarm/blackboard/boardBroadcaster.js";
import { AgentManager, type Agent } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import { config } from "../config.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Extracted from RoundRobinRunner.extractText — the session.prompt response
// shape (SDK parts array) is the same regardless of which agent profile was
// invoked. Returns the concatenated text-part content if any, else undefined.
function extractPromptText(res: unknown): string | undefined {
  const any = res as {
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      info?: { parts?: Array<{ type?: string; text?: string }> };
      text?: string;
    };
  };
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  return any?.data?.text;
}

export interface DevRouterDeps {
  broadcaster: Broadcaster;
  repos: RepoService;
}

// Temporary Phase 2 route: builds a throwaway Board and walks it through every
// BoardEvent type so a browser connected to /ws can verify the pipeline end-to-
// end. Delete once the real blackboard runner is wired up in a later phase.
export function devRouter(deps: DevRouterDeps): Router {
  const { broadcaster, repos } = deps;
  const r = Router();

  r.post("/board-poke", async (_req: Request, res: Response) => {
    const bb = createBoardBroadcaster((ev) => broadcaster.broadcast(ev));
    const board = new Board({ emit: bb.emit });
    bb.bindBoard(board);

    try {
      // 1. post + claim + commit (happy path)
      const a = board.postTodo({
        description: "rename export in src/a.ts",
        expectedFiles: ["src/a.ts"],
        createdBy: "planner-dev",
        createdAt: Date.now(),
      });
      await sleep(200);
      board.claimTodo({
        todoId: a.id,
        agentId: "agent-1",
        fileHashes: { "src/a.ts": "hashA1" },
        claimedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await sleep(200);
      board.commitTodo({
        todoId: a.id,
        agentId: "agent-1",
        currentHashes: { "src/a.ts": "hashA1" },
        committedAt: Date.now(),
      });
      await sleep(200);

      // 2. post + claim + markStale + replan + skip (rescue path)
      const b = board.postTodo({
        description: "update import in src/b.ts",
        expectedFiles: ["src/b.ts"],
        createdBy: "planner-dev",
        createdAt: Date.now(),
      });
      await sleep(200);
      board.claimTodo({
        todoId: b.id,
        agentId: "agent-2",
        fileHashes: { "src/b.ts": "hashB1" },
        claimedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await sleep(200);
      board.markStale(b.id, "simulated hash mismatch");
      await sleep(200);
      board.replan(b.id, {
        description: "update import in src/b.ts (retry)",
        expectedFiles: ["src/b.ts", "src/b.test.ts"],
      });
      await sleep(200);
      board.skip(b.id, "demo skip — not actually failing");
      await sleep(200);

      // 3. finding
      board.postFinding({
        agentId: "agent-1",
        text: "observed that /ws pipes board events correctly",
        createdAt: Date.now(),
      });
      await sleep(200);

      // Make sure a final snapshot lands even if the debounce timer hasn't fired.
      bb.flushSnapshot();
      res.json({ ok: true, counts: board.counts() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      bb.dispose();
    }
  });

  // Unit 29: swarm-ui smoke route. Validates that the Unit-26 Playwright MCP
  // infrastructure actually works end-to-end — opencode spawns, the
  // `@playwright/mcp` subprocess starts, the `swarm-ui` agent can call
  // `browser_navigate` + `browser_snapshot`, and a reply comes back.
  //
  // Runs on an ISOLATED AgentManager (its own PortAllocator, no callbacks
  // wired to the real broadcaster) so a smoke poke never appears in the UI
  // or leaks state into any active swarm.
  //
  // Request body: `{ url: string, prompt?: string }`. If `prompt` is
  // omitted, a default "navigate + snapshot" instruction is sent.
  //
  // Precondition: `MCP_PLAYWRIGHT_ENABLED=true` in .env AND
  // `@playwright/mcp` must be globally installed (`npm install -g
  // @playwright/mcp && npx playwright install`). Fails fast with a 400
  // when the flag is off so the error message is obvious, not a cryptic
  // "unknown agent profile" from opencode.
  r.post("/swarm-ui-poke", async (req: Request, res: Response) => {
    if (!config.MCP_PLAYWRIGHT_ENABLED) {
      res.status(400).json({
        error:
          "MCP_PLAYWRIGHT_ENABLED is not set to true in .env. Unit 26 must be enabled before this smoke route works. Also ensure @playwright/mcp is installed globally.",
      });
      return;
    }

    const body = (req.body ?? {}) as { url?: unknown; prompt?: unknown };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "Missing 'url' in request body." });
      return;
    }
    const promptOverride =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : null;

    const tempDir = path.join(
      os.tmpdir(),
      `swarm-ui-poke-${Math.random().toString(36).slice(2, 10)}`,
    );
    // Isolated manager — no broadcasts, no diag sink. Silent and
    // self-contained so the dev smoke doesn't touch the shared orchestrator.
    const smokeManager = new AgentManager(() => {}, () => {}, () => {});
    let agent: Agent | undefined;

    try {
      await fs.mkdir(tempDir, { recursive: true });
      // Reuse the production opencode.json writer so the smoke tests the
      // SAME shape real runs get. If Unit 26's MCP config is broken, the
      // smoke fails the same way a real swarm would.
      await repos.writeOpencodeConfig(tempDir, config.DEFAULT_MODEL);

      const promptText =
        promptOverride ??
        [
          "You have the Playwright MCP browser tools available.",
          `Step 1: call browser_navigate with url "${url}".`,
          "Step 2: call browser_snapshot once the page has loaded.",
          "Step 3: in your text response, paste the snapshot's accessibility tree VERBATIM — do not summarize, do not paraphrase, do not wrap in prose. If the snapshot fails, return the error verbatim.",
        ].join("\n");

      const t0 = Date.now();
      agent = await smokeManager.spawnAgent({
        cwd: tempDir,
        index: 99, // dev marker; not a real run-agent index
        model: config.DEFAULT_MODEL,
        skipWarmup: true, // one-shot, no cloud-warmup needed
      });
      const spawnElapsedMs = Date.now() - t0;

      const t1 = Date.now();
      const response = await agent.client.session.prompt({
        sessionID: agent.sessionId,
        agent: "swarm-ui",
        model: { providerID: "ollama", modelID: agent.model },
        parts: [{ type: "text", text: promptText }],
      });
      const promptElapsedMs = Date.now() - t1;

      const responseText = extractPromptText(response) ?? "(no text parts in response)";
      res.json({
        ok: true,
        url,
        spawnElapsedMs,
        promptElapsedMs,
        model: config.DEFAULT_MODEL,
        promptText,
        responseText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      try {
        await smokeManager.killAll();
      } catch {
        // best-effort; isolated manager, so even a leaked child is
        // bounded to this request's lifetime
      }
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort; temp dir may hang around if fs is flaky
      }
    }
    // intentionally reference broadcaster so lint doesn't flag the dep;
    // future dev routes on this router may use it.
    void broadcaster;
  });

  return r;
}
