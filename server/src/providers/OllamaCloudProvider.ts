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

  private stripCloudSuffix(model: string): string {
    return model.replace(/(?::|-)cloud$/, "");
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

    return ollamaChat({
      baseUrl: this.baseUrl,
      model: this.stripCloudSuffix(opts.model),
      messages: ollamaMessages,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      firstChunkTimeoutMs: opts.firstChunkTimeoutMs,
      options: extra.options ?? opts.options,
      logDiag: opts.logDiag,
      agentId: opts.agentId,
      apiKey: this.apiKey,
      runId: opts.runId,
      ...(extra.onChunk ? { onChunk: extra.onChunk } : opts.onChunk ? { onChunk: opts.onChunk } : {}),
      ...(extra.format !== undefined ? { format: extra.format } : opts.format !== undefined ? { format: opts.format } : {}),
      ...(extra.tools && extra.tools.length > 0 ? { tools: extra.tools } : {}),
    });
  }
}