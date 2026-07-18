// E3 Phase 1: OllamaProvider wraps the existing OllamaClient.chat. No
// new transport code — just adapts the existing ChatOpts/ChatResult
// shape to the SessionProvider contract. When OllamaProvider is the
// only impl ever called, behavior is bit-for-bit identical to today's
// USE_OLLAMA_DIRECT=1 path.

import { chat as ollamaChat, type ChatMessage, type ChatResult as OllamaTurnResult } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { config } from "../config.js";
import { configureHttpDispatcher } from "../services/httpDispatcher.js";
import { chatWithOllamaToolLoop, type OllamaLoopMessage } from "./ollamaToolLoop.js";

export class OllamaProvider implements SessionProvider {
  readonly id = "ollama" as const;

  constructor(private readonly baseUrl: string = config.OLLAMA_BASE_URL) {
    configureHttpDispatcher(this.id);
  }

  async chat(opts: ChatOpts): Promise<ChatResult> {
    return chatWithOllamaToolLoop(
      (messages, extra) => this.singleTurn(messages, opts, extra),
      opts,
    );
  }

  private async singleTurn(
    messages: OllamaLoopMessage[],
    opts: ChatOpts,
    extra: {
      tools?: Array<{
        type: "function";
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }>;
      onChunk?: ChatOpts["onChunk"];
      format?: ChatOpts["format"];
      options?: ChatOpts["options"];
    },
  ): Promise<OllamaTurnResult> {
    const ollamaMessages: ChatMessage[] = messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_name: m.tool_name };
      }
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        };
      }
      return { role: m.role, content: m.content };
    });

    let usagePrompt = 0;
    let usageResponse = 0;
    // Merge Ollama-only extras (think / keep_alive / role options). Never set
    // by OpenCode path — only this provider forwards them to OllamaClient.
    const ollamaOpts = opts.ollama;
    const mergedOptions = {
      ...(opts.options ?? {}),
      ...(ollamaOpts?.options ?? {}),
      ...(extra.options ?? {}),
    };
    const result = await ollamaChat({
      baseUrl: this.baseUrl,
      model: opts.model,
      messages: ollamaMessages,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      firstChunkTimeoutMs: opts.firstChunkTimeoutMs,
      options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
      logDiag: opts.logDiag,
      agentId: opts.agentId,
      runId: opts.runId,
      httpDispatcher: (opts as { httpDispatcher?: unknown }).httpDispatcher || configureHttpDispatcher(this.id),
      onTokens: (counts: { promptTokens: number; responseTokens: number }) => {
        usagePrompt = counts.promptTokens;
        usageResponse = counts.responseTokens;
      },
      ...(extra.onChunk ? { onChunk: extra.onChunk } : opts.onChunk ? { onChunk: opts.onChunk } : {}),
      ...(extra.format !== undefined ? { format: extra.format } : opts.format !== undefined ? { format: opts.format } : {}),
      ...(extra.tools && extra.tools.length > 0 ? { tools: extra.tools } : {}),
      ...(ollamaOpts?.think !== undefined ? { think: ollamaOpts.think } : {}),
      ...(ollamaOpts?.keepAlive !== undefined ? { keep_alive: ollamaOpts.keepAlive } : {}),
    });

    return {
      ...result,
      ...(usagePrompt + usageResponse > 0
        ? { usage: { promptTokens: usagePrompt, responseTokens: usageResponse } }
        : {}),
    };
  }
}