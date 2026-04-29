// Task #54 (2026-04-24): one-shot retry when extractTextWithDiag
// signals isEmpty=true. Skips the full promptWithRetry wrapper on the
// retry — transport errors were already handled on the first attempt;
// this is purely about getting TEXT out of a response that came back
// empty (partsLength > 0 but no type:"text" part, e.g.
// ['step-start', 'tool'] or ['step-start', 'step-finish']).
//
// Best-effort: any error during the retry returns null so the caller
// keeps its original "(empty response)" placeholder rather than
// propagating a new failure.
//
// Pattern 10 (2026-04-24): retry deadline. Without an upper bound the
// retry session.prompt has been observed (council + OW runs) to hang
// indefinitely — the model occasionally never responds to the retry
// prompt, pinning the agent until the runner's 20-min absolute-turn
// cap fires. A 60-second cap on the retry itself unblocks the agent
// loop; the orphaned cloud call drains in the background. Implemented
// with the same { AbortController + session.abort } pattern the
// per-runner watchdogs use.

import type { Agent } from "../services/AgentManager.js";
import { toOpenCodeModelRef } from "../../../shared/src/providers.js";
import {
  EMPTY_RESPONSE_RETRY_SUFFIX,
  extractTextWithDiag,
  looksLikeJunk,
} from "./extractText.js";

interface DiagCtx {
  runner: string;
  agentId: string;
  agentIndex?: number;
  logDiag?: (rec: Record<string, unknown>) => void;
}

const RETRY_DEADLINE_MS = 60_000;

export async function retryEmptyResponse(
  agent: Agent,
  originalPrompt: string,
  agentName: "swarm" | "swarm-read",
  diagCtx: DiagCtx,
): Promise<string | null> {
  diagCtx.logDiag?.({
    type: "_prompt_empty_retry",
    runner: diagCtx.runner,
    agentId: diagCtx.agentId,
    agentIndex: diagCtx.agentIndex,
    ts: Date.now(),
  });
  const retryAbort = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    retryAbort.abort(new Error(`retry deadline ${RETRY_DEADLINE_MS / 1000}s`));
    // Tell the OpenCode session to stop serving the abandoned prompt
    // so a subsequent prompt on the same session isn't queued behind it.
    void agent.client.session.abort({ sessionID: agent.sessionId }).catch(() => {});
  }, RETRY_DEADLINE_MS);
  try {
    const retryRes = await agent.client.session.prompt(
      {
        sessionID: agent.sessionId,
        agent: agentName,
        model: toOpenCodeModelRef(agent.model),
        parts: [
          { type: "text", text: originalPrompt + EMPTY_RESPONSE_RETRY_SUFFIX },
        ],
      },
      { signal: retryAbort.signal },
    );
    const { text, isEmpty } = extractTextWithDiag(retryRes, diagCtx);
    // Pattern 8: also reject the retry if it came back as junk-short
    // single-token output (the failure mode we tried to recover from
    // in the first place). Returning null keeps the original placeholder
    // / junk text rather than swapping in a different junk string.
    if (isEmpty || looksLikeJunk(text)) return null;
    return text;
  } catch {
    if (deadlineHit) {
      diagCtx.logDiag?.({
        type: "_prompt_empty_retry_deadline",
        runner: diagCtx.runner,
        agentId: diagCtx.agentId,
        agentIndex: diagCtx.agentIndex,
        deadlineMs: RETRY_DEADLINE_MS,
        ts: Date.now(),
      });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
