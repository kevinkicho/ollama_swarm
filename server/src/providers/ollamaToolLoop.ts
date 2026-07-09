// Multi-turn tool loop for Ollama / Ollama Cloud providers.
// Mirrors OpenAIProvider's dispatcher loop — required for web_search/web_fetch
// on :cloud models (the default in most blackboard runs).

import type { ChatResult as OllamaChatResult } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult } from "./SessionProvider.js";
import { TOOL_SCHEMAS } from "./AnthropicProvider.js";

const DEFAULT_MAX_TOOL_TURNS = 10;

export type OllamaLoopMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      thinking?: string;
      tool_calls?: Array<{
        type: "function";
        function: { name: string; arguments: Record<string, unknown> };
      }>;
    }
  | { role: "tool"; tool_name: string; content: string };

function buildOllamaToolDefs(
  names: NonNullable<ChatOpts["tools"]>,
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return names.map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: TOOL_SCHEMAS[name].description,
      parameters: TOOL_SCHEMAS[name].input_schema,
    },
  }));
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* */ }
  }
  return {};
}

export async function chatWithOllamaToolLoop(
  baseChat: (messages: OllamaLoopMessage[], extra: {
    tools?: ReturnType<typeof buildOllamaToolDefs>;
    onChunk?: ChatOpts["onChunk"];
    format?: ChatOpts["format"];
    options?: ChatOpts["options"];
  }) => Promise<OllamaChatResult & {
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    usage?: { promptTokens: number; responseTokens: number };
  }>,
  opts: ChatOpts,
): Promise<ChatResult> {
  const t0 = Date.now();
  const useTools = !!(opts.tools?.length && opts.dispatcher);
  if (!useTools) {
    const messages: OllamaLoopMessage[] = [];
    if (opts.system?.trim()) messages.push({ role: "system", content: opts.system });
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
    const single = await baseChat(messages, {
      onChunk: opts.onChunk,
      format: opts.format,
      options: opts.options,
    });
    return {
      text: single.text,
      elapsedMs: single.elapsedMs,
      finishReason: single.finishReason,
      ...(single.usage ? { usage: single.usage } : {}),
    };
  }

  const toolDefs = buildOllamaToolDefs(opts.tools!);
  const maxTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const messages: OllamaLoopMessage[] = [];
  if (opts.system?.trim()) messages.push({ role: "system", content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

  let cumulativeText = "";
  let cumulativePrompt = 0;
  let cumulativeResponse = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const turnResult = await baseChat(messages, {
      tools: toolDefs,
      onChunk: (snap) => {
        cumulativeText = snap;
        opts.onChunk?.(snap);
      },
      format: opts.format,
      options: opts.options,
    });

    cumulativeText = turnResult.text;
    if (turnResult.toolCalls && turnResult.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: turnResult.contentOnly ?? "",
        ...(turnResult.thinkingOnly ? { thinking: turnResult.thinkingOnly } : {}),
        tool_calls: turnResult.toolCalls.map((tc) => ({
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (const tc of turnResult.toolCalls) {
        const dispatchResult = await opts.dispatcher!.dispatch({
          tool: tc.name as Parameters<NonNullable<ChatOpts["dispatcher"]>["dispatch"]>[0]["tool"],
          args: tc.arguments,
        });
        const preview = dispatchResult.ok
          ? dispatchResult.output.slice(0, 80).replace(/\n/g, " ")
          : dispatchResult.error.slice(0, 80);
        opts.onTool?.({ tool: tc.name, ok: dispatchResult.ok, preview });
        messages.push({
          role: "tool",
          tool_name: tc.name,
          content: dispatchResult.ok ? dispatchResult.output : `ERROR: ${dispatchResult.error}`,
        });
      }
      continue;
    }

    return {
      text: cumulativeText,
      elapsedMs: Date.now() - t0,
      finishReason: turnResult.finishReason,
      ...(cumulativePrompt + cumulativeResponse > 0
        ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
        : {}),
    };
  }

  return {
    text: cumulativeText,
    elapsedMs: Date.now() - t0,
    finishReason: "error",
    errorMessage: `Ollama tool loop exceeded ${maxTurns} turns`,
  };
}

/** Normalize a streamed Ollama tool_call frame into {name, arguments}. */
export function parseOllamaToolCallFrame(raw: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const fn = (raw as { function?: { name?: string; arguments?: unknown } }).function;
  if (!fn?.name) return null;
  return { name: fn.name, arguments: parseToolArguments(fn.arguments) };
}