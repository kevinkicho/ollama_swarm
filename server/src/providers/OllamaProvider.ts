// E3 Phase 1: OllamaProvider wraps the existing OllamaClient.chat. No
// new transport code — just adapts the existing ChatOpts/ChatResult
// shape to the SessionProvider contract. When OllamaProvider is the
// only impl ever called, behavior is bit-for-bit identical to today's
// USE_OLLAMA_DIRECT=1 path.

import { chat as ollamaChat } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { config } from "../config.js";

export class OllamaProvider implements SessionProvider {
  readonly id = "ollama" as const;

  constructor(private readonly baseUrl: string = config.OLLAMA_BASE_URL) {}

  async chat(opts: ChatOpts): Promise<ChatResult> {
    // Fold `system` (if present) into messages as the leading
    // system-role entry — Ollama's /api/chat accepts the standard
    // OpenAI-style messages array.
    const messages =
      opts.system && opts.system.length > 0
        ? [{ role: "system" as const, content: opts.system }, ...opts.messages]
        : opts.messages;

    let usagePrompt = 0;
    let usageResponse = 0;
    const result = await ollamaChat({
      baseUrl: this.baseUrl,
      model: opts.model,
      messages,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      firstChunkTimeoutMs: opts.firstChunkTimeoutMs,
      options: opts.options,
      logDiag: opts.logDiag,
      agentId: opts.agentId,
      onTokens: (counts) => {
        usagePrompt = counts.promptTokens;
        usageResponse = counts.responseTokens;
      },
      ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
    });

    return {
      text: result.text,
      elapsedMs: result.elapsedMs,
      finishReason: result.finishReason,
      ...(usagePrompt + usageResponse > 0
        ? { usage: { promptTokens: usagePrompt, responseTokens: usageResponse } }
        : {}),
    };
  }
}
