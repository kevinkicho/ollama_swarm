// Multi-turn tool loop for Ollama / Ollama Cloud providers.
// Mirrors OpenAIProvider's dispatcher loop — required for web_search/web_fetch
// on :cloud models (the default in most blackboard runs).

import type { ChatResult as OllamaChatResult } from "../services/OllamaClient.js";
import type { ChatOpts, ChatResult } from "./SessionProvider.js";
import { TOOL_SCHEMAS } from "./AnthropicProvider.js";
import { formatToolInvokePreview } from "../swarm/toolCallTranscript.js";
import { createToolLoopStuckDetector } from "@ollama-swarm/shared/toolLoopStuck";

/** Provider floor when caller omits maxToolTurns (was 10 — over-restricted council drafts). */
const DEFAULT_MAX_TOOL_TURNS = 100;

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

function resolveNudges(opts: ChatOpts): Array<{ atTurn: number; message: string }> {
  const out: Array<{ atTurn: number; message: string }> = [];
  if (opts.toolLoopNudge) out.push(opts.toolLoopNudge);
  if (opts.toolLoopNudges) out.push(...opts.toolLoopNudges);
  return out;
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
  const maxTurnsRequested = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  // maxToolTurns <= 0 = emit-only: never enter the multi-turn tool loop
  // (empty for-loop would immediately report "exceeded 0 turns").
  const useTools = !!(opts.tools?.length && opts.dispatcher) && maxTurnsRequested > 0;
  if (!useTools) {
    const messages: OllamaLoopMessage[] = [];
    if (opts.system?.trim()) messages.push({ role: "system", content: opts.system });
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
    const single = await baseChat(messages, {
      onChunk: opts.onChunk,
      format: opts.format,
      options: opts.options,
    });
    if (opts.runId && opts.agentId && single.text) {
      try {
        const { registerContestToolsFromText } = await import("../tools/toolContest.js");
        registerContestToolsFromText({
          runId: opts.runId,
          agentId: opts.agentId,
          text: single.text,
        });
      } catch {
        /* best-effort */
      }
    }
    return {
      text: single.text,
      elapsedMs: single.elapsedMs,
      finishReason: single.finishReason,
      ...(single.usage ? { usage: single.usage } : {}),
    };
  }

  const toolDefs = buildOllamaToolDefs(opts.tools!);
  const maxTurns = maxTurnsRequested;
  const nudges = resolveNudges(opts);
  const stuckDetector = createToolLoopStuckDetector();
  const messages: OllamaLoopMessage[] = [];
  if (opts.system?.trim()) messages.push({ role: "system", content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

  let cumulativeText = "";
  let cumulativePrompt = 0;
  let cumulativeResponse = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    for (const nudge of nudges) {
      if (turn + 1 === nudge.atTurn) {
        messages.push({ role: "user", content: nudge.message });
      }
    }
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
    // Agent free-text contest protocol (profile denials).
    if (opts.runId && opts.agentId && (turnResult.text || turnResult.contentOnly)) {
      try {
        const { registerContestToolsFromText } = await import("../tools/toolContest.js");
        registerContestToolsFromText({
          runId: opts.runId,
          agentId: opts.agentId,
          text: `${turnResult.text ?? ""}\n${turnResult.contentOnly ?? ""}`,
        });
      } catch {
        /* best-effort */
      }
    }
    // Accumulate per-turn usage — previously left at 0 forever so tool-using
    // Ollama/cloud paths always returned empty ChatResult.usage.
    if (turnResult.usage) {
      cumulativePrompt += turnResult.usage.promptTokens ?? 0;
      cumulativeResponse += turnResult.usage.responseTokens ?? 0;
    }
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
        const stuckReason = stuckDetector.record(tc.name, dispatchResult.ok, tc.arguments);
        if (stuckReason) {
          return {
            text: cumulativeText,
            elapsedMs: Date.now() - t0,
            finishReason: "error",
            errorMessage: stuckReason,
            ...(cumulativePrompt + cumulativeResponse > 0
              ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
              : {}),
          };
        }
        const preview = formatToolInvokePreview(tc.name, tc.arguments, dispatchResult);
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
    ...(cumulativePrompt + cumulativeResponse > 0
      ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
      : {}),
  };
}

/** Normalize a streamed Ollama tool_call frame into {name, arguments}. */
export function parseOllamaToolCallFrame(raw: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const fn = (raw as { function?: { name?: string; arguments?: unknown } }).function;
  if (!fn?.name) return null;
  return { name: fn.name, arguments: parseToolArguments(fn.arguments) };
}