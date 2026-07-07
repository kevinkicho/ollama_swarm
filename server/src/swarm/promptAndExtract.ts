// Task #54 (2026-04-24): one-shot retry when extractTextWithDiag
// signals isEmpty=true. When the caller passes manager + signal in
// diagCtx, the retry stays on the same coordinated prompt+stream path
// as the first attempt (promptWithRetry). Otherwise falls back to
// chatOnce for lightweight call sites.
//
// Best-effort: any error during the retry returns null so the caller
// keeps its original "(empty response)" placeholder rather than
// propagating a new failure.
//
// Pattern 10 (2026-04-24): retry deadline. Without an upper bound the
// retry has been observed (council + OW runs) to hang indefinitely.
// A 60-second cap on the retry itself unblocks the agent loop.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import { chatOnce } from "./chatOnce.js";
import { promptWithRetry } from "./promptWithRetry.js";
import type { PromptWithRetryOptions } from "./promptWithRetry.js";
import {
  EMPTY_RESPONSE_RETRY_SUFFIX,
  extractTextWithDiag,
  looksLikeJunk,
} from "./extractText.js";

export interface DiagCtx {
  runner: string;
  agentId: string;
  agentIndex?: number;
  logDiag?: (rec: Record<string, unknown>) => void;
  /** When set with signal, empty-retry uses promptWithRetry + streaming UI. */
  manager?: AgentManager;
  signal?: AbortSignal;
  webToolsConfig?: PromptWithRetryOptions["webToolsConfig"];
  mcpServers?: string;
  onTool?: PromptWithRetryOptions["onTool"];
  promptAddendum?: string;
  modelOverride?: string;
  runId?: string;
}

const RETRY_DEADLINE_MS = 60_000;

function adaptLogDiag(
  logDiag: DiagCtx["logDiag"],
): ((record: unknown) => void) | undefined {
  if (!logDiag) return undefined;
  return (record) => logDiag(record as Record<string, unknown>);
}

export async function retryEmptyResponse(
  agent: Agent,
  originalPrompt: string,
  agentName: string,
  diagCtx: DiagCtx,
): Promise<string | null> {
  diagCtx.logDiag?.({
    type: "_prompt_empty_retry",
    runner: diagCtx.runner,
    agentId: diagCtx.agentId,
    agentIndex: diagCtx.agentIndex,
    coordinated: Boolean(diagCtx.manager),
    ts: Date.now(),
  });
  const retryAbort = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    retryAbort.abort(new Error(`retry deadline ${RETRY_DEADLINE_MS / 1000}s`));
  }, RETRY_DEADLINE_MS);
  const composed = diagCtx.signal
    ? AbortSignal.any([retryAbort.signal, diagCtx.signal])
    : retryAbort.signal;
  const retryPrompt = originalPrompt + EMPTY_RESPONSE_RETRY_SUFFIX;
  try {
    const retryRes = diagCtx.manager
      ? await promptWithRetry(agent, retryPrompt, {
          signal: composed,
          manager: diagCtx.manager,
          agentName,
          logDiag: adaptLogDiag(diagCtx.logDiag),
          runId: diagCtx.runId,
          ...(diagCtx.webToolsConfig !== undefined ? { webToolsConfig: diagCtx.webToolsConfig } : {}),
          ...(diagCtx.mcpServers !== undefined ? { mcpServers: diagCtx.mcpServers } : {}),
          ...(diagCtx.onTool !== undefined ? { onTool: diagCtx.onTool } : {}),
          ...(diagCtx.promptAddendum !== undefined ? { promptAddendum: diagCtx.promptAddendum } : {}),
          ...(diagCtx.modelOverride !== undefined ? { modelOverride: diagCtx.modelOverride } : {}),
        })
      : await chatOnce(agent, {
          agentName,
          promptText: retryPrompt,
          signal: composed,
          logDiag: adaptLogDiag(diagCtx.logDiag),
          runId: diagCtx.runId,
        });
    const { text, isEmpty } = extractTextWithDiag(retryRes, diagCtx);
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