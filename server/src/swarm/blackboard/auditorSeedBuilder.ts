// Task #164 (refactor): auditor seed assembly + Playwright UI snapshot
// extracted from BlackboardRunner.ts.
//
// The audit pass needs three sources of evidence:
//   1. The contract criteria + posted findings (cheap, in-memory).
//   2. The current contents of every expectedFile across all criteria
//      (read from the clone — supplied by caller via readFiles).
//   3. (Unit 36) An optional UI snapshot captured via Playwright MCP
//      when cfg.uiUrl is set AND MCP_PLAYWRIGHT_ENABLED. Best-effort —
//      a capture failure just omits the snapshot, the auditor falls
//      back to file-only evaluation.
//
// captureUiSnapshot spawns a one-shot swarm-ui agent in an ISOLATED
// AgentManager (no-op broadcast sinks) so it doesn't pollute the
// run's agent roster / WS stream. Cost: one spawn + one prompt per
// audit invocation. A 5-audit run with uiUrl set adds ~1-2 min of
// wall-clock overhead.

import { AgentManager } from "../../services/AgentManager.js";
import { config } from "../../config.js";
import {
  buildAuditorSeedCore,
  type AuditorSeed,
} from "./prompts/auditor.js";
import type { Board } from "./Board.js";
import type { ExitContract } from "./types.js";

export interface AuditorSeedContext {
  contract: ExitContract;
  board: Board;
  readExpectedFiles: (paths: string[]) => Promise<Record<string, string | null>>;
  auditInvocation: number;
  maxInvocations: number;
  /** When set + MCP_PLAYWRIGHT_ENABLED, capture a UI snapshot. */
  uiUrl?: string;
  /** Used as the spawned swarm-ui agent's model when capturing a snapshot. */
  model: string;
  /** Clone dir — needed for the swarm-ui agent's cwd. */
  clonePath: string;
  appendSystem: (text: string) => void;
}

export async function buildAuditorSeed(ctx: AuditorSeedContext): Promise<AuditorSeed> {
  let uiUrl: string | undefined;
  let uiSnapshot: string | undefined;
  if (
    ctx.uiUrl &&
    ctx.uiUrl.trim().length > 0 &&
    config.MCP_PLAYWRIGHT_ENABLED
  ) {
    uiUrl = ctx.uiUrl.trim();
    const snap = await captureUiSnapshot(uiUrl, ctx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`[ui-audit] snapshot capture threw: ${msg}. Proceeding without UI evidence.`);
      return null;
    });
    if (snap !== null) {
      uiSnapshot = snap;
      ctx.appendSystem(
        `[ui-audit] captured UI snapshot for ${uiUrl} (${snap.length} chars).`,
      );
    }
  } else if (ctx.uiUrl && !config.MCP_PLAYWRIGHT_ENABLED) {
    ctx.appendSystem(
      `[ui-audit] cfg.uiUrl is set but MCP_PLAYWRIGHT_ENABLED is false — cannot capture snapshot, falling back to file-only audit.`,
    );
  }

  return buildAuditorSeedCore({
    contract: ctx.contract,
    todos: ctx.board.listTodos(),
    findings: ctx.board.listFindings(),
    readFiles: (paths) => ctx.readExpectedFiles(paths),
    auditInvocation: ctx.auditInvocation,
    maxInvocations: ctx.maxInvocations,
    uiUrl,
    uiSnapshot,
  });
}

async function captureUiSnapshot(
  uiUrl: string,
  ctx: AuditorSeedContext,
): Promise<string | null> {
  const uiManager = new AgentManager(
    () => {},
    () => {},
    () => {},
  );
  let uiAgent: Awaited<ReturnType<AgentManager["spawnAgent"]>> | undefined;

  const promptText = [
    "You have the Playwright MCP browser tools available.",
    `Step 1: call browser_navigate with url "${uiUrl}".`,
    "Step 2: once the page has loaded, call browser_snapshot.",
    "Step 3: paste the browser_snapshot's accessibility tree VERBATIM in your text response. Do not summarize, do not paraphrase.",
    "If any step fails (page unreachable, browser error), return the error text verbatim so the auditor can reason about it.",
  ].join("\n");

  try {
    uiAgent = await uiManager.spawnAgent({
      cwd: ctx.clonePath,
      index: 100,
      model: ctx.model,
      skipWarmup: true,
    });
    const response = await uiAgent.client.session.prompt({
      sessionID: uiAgent.sessionId,
      agent: "swarm-ui",
      model: { providerID: "ollama", modelID: uiAgent.model },
      parts: [{ type: "text", text: promptText }],
    });
    const any = response as {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: { parts?: Array<{ type?: string; text?: string }> };
        text?: string;
      };
    };
    const parts = any?.data?.parts ?? any?.data?.info?.parts;
    let text: string | undefined;
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (texts.length) text = texts.join("\n");
    }
    if (!text) text = any?.data?.text;
    return text ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[ui-audit] swarm-ui spawn/prompt failed: ${msg}`);
    return null;
  } finally {
    try {
      await uiManager.killAll();
    } catch {
      // best-effort; isolated manager, so a leaked child is bounded
    }
  }
}
