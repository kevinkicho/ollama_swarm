import { Router, type Request, type Response } from "express";
import type { Broadcaster } from "../ws/broadcast.js";
import type { RepoService } from "../services/RepoService.js";

// Extracted from RoundRobinRunner.extractText — the session.prompt response
// shape (SDK parts array) is the same regardless of which agent profile was
// invoked. Returns the concatenated text-part content if any, else undefined.
function _extractPromptText(res: unknown): string | undefined {
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
  // Runs on an ISOLATED AgentManager (no callbacks wired to the real
  // broadcaster) so a smoke poke never appears in the UI or leaks state
  // into any active swarm.
  //
  // Request body: `{ url: string, prompt?: string }`. If `prompt` is
  // omitted, a default "navigate + snapshot" instruction is sent.
  //
  // Precondition: `MCP_PLAYWRIGHT_ENABLED=true` in .env AND
  // `@playwright/mcp` must be globally installed (`npm install -g
  // @playwright/mcp && npx playwright install`). Fails fast with a 400
  // when the flag is off so the error message is obvious, not a cryptic
  // "unknown agent profile" from opencode.
  r.post("/swarm-ui-poke", async (_req: Request, res: Response) => {
    // E3 Phase 5 cleanup pt 5: this smoke route was Playwright-MCP-via-
    // opencode-only. With opencode + MCP-via-opencode gone, there's no
    // current path to drive Playwright tools. When MCP support lands in
    // ToolDispatcher (Phase 4 part 3), reimplement here using chatOnce +
    // an MCP-aware tool list. Until then: 410 Gone with a clear note.
    void broadcaster;
    void repos;
    res.status(410).json({
      error: "swarm-ui-poke removed in E3 Phase 5 (opencode + Playwright-MCP-via-opencode gone). Reimplement when ToolDispatcher gains MCP support.",
    });
  });

  return r;
}
