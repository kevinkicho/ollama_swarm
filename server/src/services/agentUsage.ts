/**
 * Pure usage extraction for non-Ollama provider message.updated events.
 * Extracted from AgentManager (god-file modularization).
 */

// Phase 3 of #314: pure extractor — given a message.updated event's
// info payload, return a UsageRecord-shaped object when the message
// is a finished assistant turn from a non-Ollama provider with real
// token counts. Ollama is excluded because the proxy already captures
// it; double-counting would inflate the cost cap. Returns null in
// every other case so the caller's call site stays one branch.
export interface ExtractedUsage {
  ts: number;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  model: string;
  path: string;
}

export function extractUsageFromMessageInfo(info: {
  role?: string;
  providerID?: string;
  modelID?: string;
  time?: { completed?: number };
  tokens?: { input?: number; output?: number };
}): ExtractedUsage | null {
  if (info.role !== "assistant") return null;
  if (!info.providerID || info.providerID === "ollama") return null;
  if (info.time?.completed === undefined) return null;
  const promptTokens = info.tokens?.input ?? 0;
  const responseTokens = info.tokens?.output ?? 0;
  if (promptTokens + responseTokens <= 0) return null;
  // Reconstruct the prefixed model string so CostTracker.detectProvider
  // works downstream. Fallback to providerID alone when modelID missing.
  const model = info.modelID ? `${info.providerID}/${info.modelID}` : info.providerID;
  return {
    ts: Date.now(),
    promptTokens,
    responseTokens,
    durationMs: 0,
    model,
    path: "/sdk-direct",
  };
}
