// OpenCodeProvider — routes to OpenCode Go (subscription) and Zen (pay-as-you-go).
// Both use OpenAI-compatible /v1/chat/completions endpoints.
//
// Go:    https://opencode.ai/zen/go/v1/chat/completions  (subscription, limited)
// Zen:   https://opencode.ai/zen/v1/chat/completions     (pay-as-you-go, auto-reload)
//
// Model routing:
//   opencode-go/<model>  → Go endpoint  (e.g. opencode-go/glm-5.1)
//   opencode/<model>     → Zen endpoint (e.g. opencode/glm-5.1)
//   opencode-zen/<model> → Zen endpoint (explicit)
//
// Usage limits on Go trigger a 429 response. When Zen balance is available
// and "Use balance" is enabled, the same API key works for both — the server
// handles the fallback transparently.

import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { config } from "../config.js";

const GO_BASE = "https://opencode.ai/zen/go/v1/chat/completions";
const ZEN_BASE = "https://opencode.ai/zen/v1/chat/completions";

export class OpenCodeProvider implements SessionProvider {
  readonly id = "opencode" as const;

  private readonly goKey: string;
  private readonly zenKey: string;

  constructor() {
    this.goKey = config.OPENCODE_GO_API_KEY || config.OPENCODE_API_KEY || "";
    this.zenKey = config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY || "";
  }

  /** Derive which endpoint and key to use based on model prefix. */
  private route(model: string): { key: string; base: string; bareModel: string } {
    if (model.startsWith("opencode-go/")) {
      return { key: this.goKey, base: GO_BASE, bareModel: model.replace("opencode-go/", "") };
    }
    // opencode/ and opencode-zen/ both route to Zen
    const bareModel = model.replace(/^opencode(-zen)?\//, "");
    return { key: this.zenKey, base: ZEN_BASE, bareModel };
  }

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const t0 = Date.now();
    const { key, base, bareModel } = this.route(opts.model);

    if (!key) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage: `OpenCode API key not set. Set OPENCODE_GO_API_KEY and/or OPENCODE_ZEN_API_KEY in .env`,
      };
    }

    const messages = opts.system
      ? [{ role: "system" as const, content: opts.system }, ...opts.messages]
      : opts.messages;

    const body: Record<string, unknown> = {
      model: bareModel,
      messages,
      stream: false,
    };

    if (opts.format) {
      // OpenCode Go/Zen uses OpenAI-compatible endpoints which only support
      // specific response_format.type values: "json_object", "json_schema",
      // "regex", "text". Raw JSON Schema objects with type "object" or plain
      // structured json_schema enforcement are not supported by many backends
      // (DeepSeek, etc.). Downgrade to json_object in all cases except when
      // the format is already a recognized accepted type.
      if (typeof opts.format === "string") {
        // "json" → { type: "json_object" }
        body.response_format = { type: "json_object" as const };
      } else if (opts.format.type === "json_object" || opts.format.type === "json_schema"
        || opts.format.type === "regex" || opts.format.type === "text") {
        // Already a valid OpenAI-compatible response_format — pass through
        body.response_format = opts.format;
      } else {
        // Raw JSON Schema ({ type: "object", properties: {...} }) or
        // unknown format → downgrade to json_object for compatibility
        body.response_format = { type: "json_object" as const };
      }
    }

    if (opts.options) {
      if (opts.options.temperature !== undefined) body.temperature = opts.options.temperature;
      if (opts.options.top_p !== undefined) body.top_p = opts.options.top_p;
    }

    try {
      const response = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        let errorMsg = `OpenCode API returned ${response.status}`;

        if (response.status === 429) {
          errorMsg = `OpenCode rate limit exceeded${base.includes("go") ? " (Go subscription limit reached — enable Zen balance fallback in console)" : " (Zen rate limit)"}`;
        } else if (response.status === 401) {
          errorMsg = "OpenCode API key invalid or expired";
        } else if (response.status === 402) {
          errorMsg = "OpenCode Zen balance depleted — add credits at opencode.ai/auth";
        } else if (response.status === 408 || response.status === 504 || response.status === 524) {
          errorMsg = `OpenCode API timeout (HTTP ${response.status}) — model may have been slow on this prompt`;
        } else if (response.status >= 500) {
          errorMsg = `OpenCode API server error (HTTP ${response.status})${errorText ? ` — ${errorText.slice(0, 300)}` : ""}`;
        } else if (response.status === 400) {
          errorMsg = `OpenCode API bad request (HTTP 400) — ${errorText.slice(0, 500)}`;
        } else if (errorText) {
          try {
            const parsed = JSON.parse(errorText);
            errorMsg = parsed.error?.message || errorMsg;
          } catch {
            errorMsg = `OpenCode API HTTP ${response.status} — ${errorText.slice(0, 500)}`;
          }
        }

        // Diagnostic log for all errors — surfaces the actual API response for debugging
        console.warn(`[OpenCodeProvider] ${base} model=${bareModel} status=${response.status} error="${errorMsg}" raw="${errorText.slice(0, 500)}"`);

        return {
          text: "",
          elapsedMs: Date.now() - t0,
          finishReason: "error",
          errorMessage: errorMsg,
        };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? "";
      const usage = data.usage
        ? { promptTokens: data.usage.prompt_tokens ?? 0, responseTokens: data.usage.completion_tokens ?? 0 }
        : undefined;

      return {
        text,
        elapsedMs: Date.now() - t0,
        finishReason: "done",
        usage,
      };
    } catch (err) {
      if (opts.signal?.aborted) {
        return { text: "", elapsedMs: Date.now() - t0, finishReason: "aborted" };
      }
      return {
        text: "",
        elapsedMs: Date.now() - t0,
        finishReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
