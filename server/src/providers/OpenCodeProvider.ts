// OpenCode Go (subscription) + Zen (pay-as-you-go).
// Per-model endpoints per https://opencode.ai/docs/go/ and https://opencode.ai/docs/zen/:
//   OpenAI-compatible → /v1/chat/completions
//   Anthropic-compatible → /v1/messages
// Go tier:  https://opencode.ai/zen/go/v1/...
// Zen tier: https://opencode.ai/zen/v1/...

import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { TOOL_SCHEMAS, readAnthropicStreamFull } from "./AnthropicProvider.js";
import { readOpenAiStreamFull } from "./OpenAIProvider.js";
import { formatToolInvokePreview } from "../swarm/toolCallTranscript.js";
import { describeSdkError } from "../swarm/sdkError.js";
import { config } from "../config.js";
import { resolveOpenCodeRoute, type OpenCodeTier } from "./openCodeModelRouting.js";
import { structuredFormatForChat } from "./structuredFormat.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_TURNS = 100;

function openCodeFetchErrorResult(
  err: unknown,
  cumulativeText: string,
  elapsedMs: number,
  aborted: boolean,
): ChatResult {
  const cause = err instanceof Error ? err : new Error(String(err));
  return {
    text: cumulativeText,
    elapsedMs,
    finishReason: aborted ? "aborted" : "error",
    errorMessage: describeSdkError(cause),
    errorCause: cause,
  };
}

type OpenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function responseFormatBody(format: ChatOpts["format"]): Record<string, unknown> | undefined {
  return structuredFormatForChat({ format, model: "", messages: [], signal: new AbortController().signal }).openAi;
}

function keyForTier(tier: OpenCodeTier, goKey: string, zenKey: string): string {
  return tier === "go" ? goKey : zenKey;
}

export class OpenCodeProvider implements SessionProvider {
  readonly id = "opencode" as const;

  private readonly goKey: string;
  private readonly zenKey: string;

  constructor() {
    this.goKey = config.OPENCODE_GO_API_KEY || config.OPENCODE_API_KEY || "";
    this.zenKey = config.OPENCODE_ZEN_API_KEY || config.OPENCODE_API_KEY || "";
  }

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const route = resolveOpenCodeRoute(opts.model);
    const key = keyForTier(route.tier, this.goKey, this.zenKey);

    if (!key) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage:
          route.tier === "go"
            ? "OpenCode Go API key not set — set OPENCODE_GO_API_KEY or OPENCODE_API_KEY in .env"
            : "OpenCode Zen API key not set — set OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY in .env",
      };
    }

    opts.logDiag?.({
      type: "_opencode_call",
      agentId: opts.agentId,
      model: route.bareModel,
      tier: route.tier,
      api: route.api,
      url: route.url,
      promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
      tools: opts.tools?.length ?? 0,
      ts: Date.now(),
    });

    if (route.api === "messages") {
      return this.chatViaAnthropicMessages(opts, route.url, key, route.bareModel, route.tier);
    }
    return this.chatViaOpenAiCompletions(opts, route.url, key, route.bareModel, route.tier);
  }

  private async chatViaOpenAiCompletions(
    opts: ChatOpts,
    url: string,
    key: string,
    bareModel: string,
    tier: OpenCodeTier,
  ): Promise<ChatResult> {
    const t0 = Date.now();
    const useTools = !!(opts.tools && opts.tools.length > 0 && opts.dispatcher);
    const messages: OpenAiMessage[] = [];
    if (opts.system?.trim()) {
      messages.push({ role: "system", content: opts.system });
    }
    for (const m of opts.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const tools = useTools
      ? opts.tools!.map((name) => ({
          type: "function" as const,
          function: {
            name,
            description: TOOL_SCHEMAS[name].description,
            parameters: TOOL_SCHEMAS[name].input_schema,
          },
        }))
      : undefined;

    let cumulativeText = "";
    let cumulativePrompt = 0;
    let cumulativeResponse = 0;
    const maxToolTurns = opts.maxToolTurns ?? MAX_TOOL_TURNS;

    for (let turn = 0; turn < maxToolTurns; turn++) {
      const body: Record<string, unknown> = {
        model: bareModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools ? { tools } : {}),
        ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
        ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
        ...responseFormatBody(opts.format),
      };

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          signal: opts.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return openCodeFetchErrorResult(
          err,
          cumulativeText,
          Date.now() - t0,
          opts.signal.aborted,
        );
      }

      if (!resp.ok || !resp.body) {
        const errorText = await resp.text().catch(() => "");
        const errorMessage = formatOpenCodeHttpError(resp.status, errorText, tier, url);
        console.warn(
          `[OpenCodeProvider] ${url} model=${bareModel} status=${resp.status} error="${errorMessage}" raw="${errorText.slice(0, 500)}"`,
        );
        const httpErr = new Error(errorMessage);
        (httpErr as Error & { status?: number }).status = resp.status;
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: "error",
          errorMessage,
          errorCause: httpErr,
        };
      }

      const turnResult = await readOpenAiStreamFull(resp.body, opts);
      cumulativeText += turnResult.text;
      cumulativePrompt += turnResult.promptTokens;
      cumulativeResponse += turnResult.responseTokens;

      if (turnResult.finishReason !== "done") {
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: turnResult.finishReason,
          ...(cumulativePrompt + cumulativeResponse > 0
            ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
            : {}),
          ...(turnResult.errorMessage ? { errorMessage: turnResult.errorMessage } : {}),
        };
      }

      if (!useTools || turnResult.toolCalls.length === 0 || turnResult.stopReason !== "tool_calls") {
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: "done",
          ...(cumulativePrompt + cumulativeResponse > 0
            ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
            : {}),
        };
      }

      messages.push({
        role: "assistant",
        content: turnResult.text || null,
        tool_calls: turnResult.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argsJson },
        })),
      });

      for (const c of turnResult.toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = c.argsJson ? JSON.parse(c.argsJson) : {};
        } catch {
          /* empty */
        }
        const dispatchResult = await opts.dispatcher!.dispatch({
          tool: c.name as "read" | "grep" | "glob" | "list" | "bash" | "web_fetch" | "web_search",
          args: parsedArgs,
        });
        const preview = formatToolInvokePreview(c.name, parsedArgs, dispatchResult);
        opts.onTool?.({ tool: c.name, ok: dispatchResult.ok, preview });
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: dispatchResult.ok ? dispatchResult.output : `ERROR: ${dispatchResult.error}`,
        });
      }
    }

    return {
      text: cumulativeText,
      elapsedMs: Date.now() - t0,
      finishReason: "error",
      errorMessage: `OpenCode tool loop exceeded ${maxToolTurns} turns`,
      ...(cumulativePrompt + cumulativeResponse > 0
        ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
        : {}),
    };
  }

  private async chatViaAnthropicMessages(
    opts: ChatOpts,
    url: string,
    key: string,
    bareModel: string,
    tier: OpenCodeTier,
  ): Promise<ChatResult> {
    const t0 = Date.now();
    const maxTokens = (opts.options?.max_tokens as number | undefined) ?? 8192;
    const useTools = !!(opts.tools && opts.tools.length > 0 && opts.dispatcher);

    type AnthroMessage = { role: "user" | "assistant"; content: string | unknown[] };
    const messages: AnthroMessage[] = opts.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    const tools = useTools
      ? opts.tools!.map((name) => ({
          name,
          description: TOOL_SCHEMAS[name].description,
          input_schema: TOOL_SCHEMAS[name].input_schema,
        }))
      : undefined;

    let cumulativeText = "";
    let cumulativePrompt = 0;
    let cumulativeResponse = 0;
    const maxToolTurns = opts.maxToolTurns ?? MAX_TOOL_TURNS;
    const structured = structuredFormatForChat(opts);

    for (let turn = 0; turn < maxToolTurns; turn++) {
      const body = JSON.stringify({
        model: bareModel,
        max_tokens: maxTokens,
        stream: true,
        ...(opts.system ? { system: opts.system } : {}),
        messages,
        ...(tools ? { tools } : {}),
        ...(structured.anthropic ? { output_format: structured.anthropic.output_format } : {}),
        ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
        ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
      });

      const anthropicHeaders: Record<string, string> = {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      };
      if (structured.anthropic) {
        anthropicHeaders["anthropic-beta"] = structured.anthropic.beta;
      }

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          signal: opts.signal,
          headers: anthropicHeaders,
          body,
        });
      } catch (err) {
        return openCodeFetchErrorResult(
          err,
          cumulativeText,
          Date.now() - t0,
          opts.signal.aborted,
        );
      }

      if (!resp.ok || !resp.body) {
        const errorText = await resp.text().catch(() => "");
        const errorMessage = formatOpenCodeHttpError(resp.status, errorText, tier, url);
        console.warn(
          `[OpenCodeProvider] ${url} model=${bareModel} status=${resp.status} error="${errorMessage}" raw="${errorText.slice(0, 500)}"`,
        );
        const httpErr = new Error(errorMessage);
        (httpErr as Error & { status?: number }).status = resp.status;
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: "error",
          errorMessage,
          errorCause: httpErr,
        };
      }

      const turnResult = await readAnthropicStreamFull(resp.body, opts);
      cumulativePrompt += turnResult.promptTokens;
      cumulativeResponse += turnResult.responseTokens;

      for (const b of turnResult.blocks) {
        if (b.type === "text") cumulativeText += b.text;
      }

      if (turnResult.finishReason !== "done") {
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: turnResult.finishReason,
          ...(cumulativePrompt + cumulativeResponse > 0
            ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
            : {}),
          ...(turnResult.errorMessage ? { errorMessage: turnResult.errorMessage } : {}),
        };
      }

      const toolUses = turnResult.blocks.filter(
        (b): b is Extract<(typeof turnResult.blocks)[number], { type: "tool_use" }> =>
          b.type === "tool_use",
      );
      if (!useTools || toolUses.length === 0 || turnResult.stopReason !== "tool_use") {
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: "done",
          ...(cumulativePrompt + cumulativeResponse > 0
            ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
            : {}),
        };
      }

      messages.push({ role: "assistant", content: turnResult.blocks });
      const toolResults: unknown[] = [];
      for (const t of toolUses) {
        const dispatchResult = await opts.dispatcher!.dispatch({
          tool: t.name as "read" | "grep" | "glob" | "list" | "bash" | "web_fetch" | "web_search",
          args: t.input,
        });
        const preview = formatToolInvokePreview(
          t.name,
          (t.input && typeof t.input === "object" ? t.input : {}) as Record<string, unknown>,
          dispatchResult,
        );
        opts.onTool?.({ tool: t.name, ok: dispatchResult.ok, preview });
        toolResults.push({
          type: "tool_result",
          tool_use_id: t.id,
          content: dispatchResult.ok ? dispatchResult.output : `ERROR: ${dispatchResult.error}`,
          ...(dispatchResult.ok ? {} : { is_error: true }),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    return {
      text: cumulativeText,
      elapsedMs: Date.now() - t0,
      finishReason: "error",
      errorMessage: `OpenCode tool loop exceeded ${maxToolTurns} turns`,
      ...(cumulativePrompt + cumulativeResponse > 0
        ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
        : {}),
    };
  }
}

export function formatOpenCodeHttpError(
  status: number,
  errorText: string,
  tier: OpenCodeTier,
  url: string,
): string {
  let parsedMsg: string | undefined;
  try {
    const parsed = JSON.parse(errorText) as { error?: { message?: string; type?: string } };
    parsedMsg = parsed.error?.message;
  } catch {
    /* ignore */
  }

  if (status === 429) {
    return tier === "go"
      ? "OpenCode Go subscription limit reached — enable Zen balance fallback at opencode.ai/auth or wait for reset"
      : "OpenCode Zen rate limit exceeded";
  }
  if (status === 401) {
    if (parsedMsg?.toLowerCase().includes("insufficient balance")) {
      return "OpenCode Zen balance depleted — add credits at opencode.ai/auth or use opencode-go/ models with your Go subscription";
    }
    return "OpenCode API key invalid or expired";
  }
  if (status === 402) {
    return "OpenCode Zen balance depleted — add credits at opencode.ai/auth";
  }
  if (status === 408 || status === 504 || status === 524) {
    return `OpenCode API timeout (HTTP ${status})`;
  }
  if (status >= 500) {
    return `OpenCode API server error (HTTP ${status})${parsedMsg ? ` — ${parsedMsg}` : ""}`;
  }
  if (status === 400) {
    return `OpenCode API bad request — ${parsedMsg ?? errorText.slice(0, 500)}`;
  }
  if (parsedMsg) return parsedMsg;
  return `OpenCode API HTTP ${status}${errorText ? ` — ${errorText.slice(0, 500)}` : ""}`;
}