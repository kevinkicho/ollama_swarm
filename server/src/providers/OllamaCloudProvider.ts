import { chat as ollamaChat, type ChatMessage, type ChatResult as OllamaTurnResult } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { config } from "../config.js";
import { chatWithOllamaToolLoop, type OllamaLoopMessage } from "./ollamaToolLoop.js";

export class OllamaCloudProvider implements SessionProvider {
  readonly id = "ollama-cloud" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = "https://ollama.com";
    const key = config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY || "";
    this.apiKey = key;
  }

  /**
   * ollama.com chat expects bare API names from GET /api/tags
   * (e.g. gpt-oss:120b, glm-5.2). Local topology uses :cloud / -cloud tags.
   */
  private stripCloudSuffix(model: string): string {
    return model.replace(/(?::|-)cloud$/i, "");
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
    const ollamaOpts = opts.ollama;
    const mergedOptions = {
      ...(opts.options ?? {}),
      ...(ollamaOpts?.options ?? {}),
      ...(extra.options ?? {}),
    };
    const result = await ollamaChat({
      baseUrl: this.baseUrl,
      model: this.stripCloudSuffix(opts.model),
      messages: ollamaMessages,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      firstChunkTimeoutMs: opts.firstChunkTimeoutMs,
      options: Object.keys(mergedOptions).length > 0 ? mergedOptions : undefined,
      logDiag: opts.logDiag,
      agentId: opts.agentId,
      apiKey: this.apiKey,
      runId: opts.runId,
      // Same as OllamaProvider: capture prompt_eval_count / eval_count (or
      // cloud-equivalent fields) so tool loops and recordChatUsage get real meters.
      onTokens: (counts: { promptTokens: number; responseTokens: number }) => {
        usagePrompt = counts.promptTokens;
        usageResponse = counts.responseTokens;
      },
      ...(extra.onChunk ? { onChunk: extra.onChunk } : opts.onChunk ? { onChunk: opts.onChunk } : {}),
      ...(extra.format !== undefined ? { format: extra.format } : opts.format !== undefined ? { format: opts.format } : {}),
      ...(extra.tools && extra.tools.length > 0 ? { tools: extra.tools } : {}),
      // Ollama Cloud API supports the same chat fields; OpenCode never reaches here.
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