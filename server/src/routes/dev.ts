import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { Broadcaster } from "../ws/broadcast.js";
import { AgentManager, type Agent } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import { config } from "../config.js";

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

// Dev-only routes. /board-poke removed in V2 cutover Phase 2d
// (2026-04-28) — it was a throwaway Board exerciser before the
// real blackboard runner shipped; obsolete now that V2 queue is
// the only state model. /swarm-ui-poke survives.
export function devRouter(deps: DevRouterDeps): Router {
  const { broadcaster, repos } = deps;
  const r = Router();

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
