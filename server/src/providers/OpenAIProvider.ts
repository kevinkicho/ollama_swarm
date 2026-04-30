// E3 Phase 1 + Phase 4 part 2: OpenAIProvider — raw fetch against
// api.openai.com. No SDK dep. Supports text-only chat (Phase 1) and
// the multi-turn tool_calls loop (Phase 4 part 2).
//
// Streaming protocol (https://platform.openai.com/docs/api-reference/chat/streaming):
//   SSE events with `data: <json>` lines, ending with `data: [DONE]`.
//   Each chunk: { choices: [{ delta: { content?, tool_calls? } }], usage? }
//   Tool calls stream as delta.tool_calls = [{ index, id?, function: { name?, arguments? } }],
//   with name + arguments accumulated across chunks (arguments is a
//   JSON string streamed in fragments).
//
// Tool round-trip:
//   1. Send messages + tools
//   2. Parse stream into final text + accumulated tool_calls
//   3. If finish_reason="tool_calls": append assistant message with
//      tool_calls; for each call dispatch via dispatcher; append a
//      role:"tool" message per call keyed by tool_call_id; restart.
//   4. Else: return cumulative text + cumulative usage.

import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";
import { TOOL_SCHEMAS } from "./AnthropicProvider.js";

const OPENAI_BASE = "https://api.openai.com/v1/chat/completions";
const MAX_TOOL_TURNS = 10;

interface OpenAiSseChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAiToolCall {
  id: string;
  name: string;
  argsJson: string;
}

interface OpenAiStreamFullResult {
  text: string;
  toolCalls: OpenAiToolCall[];
  finishReason: "done" | "aborted" | "idle-timeout" | "error";
  stopReason: string | null;
  promptTokens: number;
  responseTokens: number;
  errorMessage?: string;
}

export class OpenAIProvider implements SessionProvider {
  readonly id = "openai" as const;

  constructor(private readonly apiKey: string = process.env.OPENAI_API_KEY ?? "") {}

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage: "OPENAI_API_KEY not set",
      };
    }
    opts.logDiag?.({
      type: "_openai_call",
      agentId: opts.agentId,
      model: opts.model,
      promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
      tools: opts.tools?.length ?? 0,
      ts: t0,
    });

    const useTools = !!(opts.tools && opts.tools.length > 0 && opts.dispatcher);

    // Running messages array. OpenAI: each entry has role + content
    // (string OR null when tool_calls present) + optional tool_calls /
    // tool_call_id. We start from opts.messages and grow via the loop.
    type OpenAiMessage = {
      role: "system" | "user" | "assistant" | "tool";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    };
    const messages: OpenAiMessage[] = [];
    if (opts.system && opts.system.length > 0) {
      messages.push({ role: "system", content: opts.system });
    }
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

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

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const body = JSON.stringify({
        model: opts.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools ? { tools } : {}),
        ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
        ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
      });

      let resp: Response;
      try {
        resp = await fetch(OPENAI_BASE, {
          method: "POST",
          signal: opts.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: opts.signal.aborted ? "aborted" : "error",
          errorMessage: msg,
        };
      }
      if (!resp.ok || !resp.body) {
        const errBody = await resp.text().catch(() => "");
        return {
          text: cumulativeText,
          elapsedMs: Date.now() - t0,
          finishReason: "error",
          errorMessage: `HTTP ${resp.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
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

      // Append assistant tool-calls message + tool-result messages.
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
        try { parsedArgs = c.argsJson ? JSON.parse(c.argsJson) : {}; } catch { /* leave empty */ }
        const dispatchResult = await opts.dispatcher!.dispatch({
          tool: c.name as "read" | "grep" | "glob" | "list" | "bash",
          args: parsedArgs,
        });
        const preview = dispatchResult.ok
          ? dispatchResult.output.slice(0, 80).replace(/\n/g, " ")
          : dispatchResult.error.slice(0, 80);
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
      errorMessage: `OpenAI tool loop exceeded ${MAX_TOOL_TURNS} turns`,
      ...(cumulativePrompt + cumulativeResponse > 0
        ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Stream readers — exported for tests.
// ---------------------------------------------------------------------------

/** Full reader: returns text + tool_calls + finish_reason + usage. */
export async function readOpenAiStreamFull(
  body: ReadableStream<Uint8Array>,
  opts: Pick<ChatOpts, "signal" | "idleTimeoutMs" | "firstChunkTimeoutMs" | "onChunk">,
): Promise<OpenAiStreamFullResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let promptTokens = 0;
  let responseTokens = 0;
  let stopReason: string | null = null;
  let lastChunkAt = Date.now();
  let firstChunkSeen = false;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? 180_000;
  // Per tool-call-index: id + name + accumulated arguments JSON string.
  const toolCallState = new Map<number, { id: string; name: string; argsJson: string }>();

  const checkTimeout = () => {
    const sinceLast = Date.now() - lastChunkAt;
    if (firstChunkSeen) return sinceLast >= idleTimeoutMs ? "idle-timeout" : null;
    return sinceLast >= firstChunkTimeoutMs ? "idle-timeout" : null;
  };

  const finalize = (fr: OpenAiStreamFullResult["finishReason"], errorMessage?: string): OpenAiStreamFullResult => {
    const indices = [...toolCallState.keys()].sort((a, b) => a - b);
    const toolCalls: OpenAiToolCall[] = indices.map((i) => {
      const s = toolCallState.get(i)!;
      return { id: s.id, name: s.name, argsJson: s.argsJson };
    });
    return {
      text,
      toolCalls,
      finishReason: fr,
      stopReason,
      promptTokens,
      responseTokens,
      ...(errorMessage ? { errorMessage } : {}),
    };
  };

  while (true) {
    if (opts.signal.aborted) return finalize("aborted");
    const timeoutReason = checkTimeout();
    if (timeoutReason) return finalize(timeoutReason);

    let chunk: { done: boolean; value?: Uint8Array };
    const TIMEOUT_TICK_MS = 200;
    try {
      const timeoutSentinel = Symbol("timeout");
      const raced = await Promise.race<typeof timeoutSentinel | { done: boolean; value?: Uint8Array }>([
        reader.read(),
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), TIMEOUT_TICK_MS),
        ),
      ]);
      if (raced === timeoutSentinel) continue;
      chunk = raced;
    } catch (err) {
      if (opts.signal.aborted) return finalize("aborted");
      return finalize("error", err instanceof Error ? err.message : String(err));
    }
    if (chunk.done) break;
    if (chunk.value && chunk.value.length > 0) {
      lastChunkAt = Date.now();
      firstChunkSeen = true;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length).trim();
        if (payload === "[DONE]") {
          return finalize("done");
        }
        let ev: OpenAiSseChunk;
        try { ev = JSON.parse(payload) as OpenAiSseChunk; } catch { continue; }
        const choice = ev.choices?.[0];
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        const deltaContent = choice?.delta?.content;
        if (typeof deltaContent === "string") {
          text += deltaContent;
          opts.onChunk?.(text);
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            let state = toolCallState.get(idx);
            if (!state) {
              state = { id: tc.id ?? "", name: tc.function?.name ?? "", argsJson: "" };
              toolCallState.set(idx, state);
            } else {
              if (tc.id) state.id = tc.id;
              if (tc.function?.name) state.name = tc.function.name;
            }
            if (tc.function?.arguments) state.argsJson += tc.function.arguments;
          }
        }
        if (ev.usage) {
          promptTokens = ev.usage.prompt_tokens ?? promptTokens;
          responseTokens = ev.usage.completion_tokens ?? responseTokens;
        }
      }
    }
  }
  return finalize("done");
}

/** Back-compat reader for the Phase 1 tests that returned just text + usage. */
export async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  opts: Pick<ChatOpts, "signal" | "idleTimeoutMs" | "firstChunkTimeoutMs" | "onChunk">,
  t0: number,
): Promise<ChatResult> {
  const result = await readOpenAiStreamFull(body, opts);
  return {
    text: result.text,
    elapsedMs: Date.now() - t0,
    finishReason: result.finishReason,
    ...(result.promptTokens + result.responseTokens > 0
      ? { usage: { promptTokens: result.promptTokens, responseTokens: result.responseTokens } }
      : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}
