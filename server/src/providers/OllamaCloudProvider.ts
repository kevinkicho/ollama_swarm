import { chat as ollamaChat } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { config } from "../config.js";

export class OllamaCloudProvider implements SessionProvider {
  readonly id = "ollama-cloud" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = "https://ollama.com";
    const key = config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY || "";
    this.apiKey = key;
  }

  // Ollama Cloud API uses bare model names without the :cloud / -cloud
  // suffix (e.g. "glm-5.1" not "glm-5.1:cloud"). Strip it before sending.
  private stripCloudSuffix(model: string): string {
    return model.replace(/(?::|-)cloud$/, "");
  }

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const messages =
      opts.system && opts.system.length > 0
        ? [{ role: "system" as const, content: opts.system }, ...opts.messages]
        : opts.messages;

    let usagePrompt = 0;
    let usageResponse = 0;
    const result = await ollamaChat({
      baseUrl: this.baseUrl,
      model: this.stripCloudSuffix(opts.model),
      messages,
      signal: opts.signal,
      idleTimeoutMs: opts.idleTimeoutMs,
      firstChunkTimeoutMs: opts.firstChunkTimeoutMs,
      options: opts.options,
      logDiag: opts.logDiag,
      agentId: opts.agentId,
      apiKey: this.apiKey,
      runId: opts.runId,
      onTokens: (counts) => {
        usagePrompt = counts.promptTokens;
        usageResponse = counts.responseTokens;
      },
      ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
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