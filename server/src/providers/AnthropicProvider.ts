// E3 Phase 1 + Phase 4 part 2: AnthropicProvider — raw fetch against
// api.anthropic.com. No @anthropic-ai/sdk dep. Supports both pure-text
// chat (Phase 1) and the multi-turn tool_use loop (Phase 4 part 2).
//
// Streaming protocol (https://docs.anthropic.com/en/api/messages-streaming):
//   SSE events with `event: <type>` and `data: { ... }` lines.
//   - message_start          → message metadata (id, model, usage.input_tokens)
//   - content_block_start    → start of a content block (text OR tool_use)
//   - content_block_delta    → text_delta OR input_json_delta (for tool_use)
//   - content_block_stop     → end of block
//   - message_delta          → { stop_reason, usage.output_tokens }
//   - message_stop           → terminal
//
// Tool loop: when opts.tools && opts.dispatcher, the request body
// declares tools. The model may emit tool_use content blocks; we
// dispatch each via the dispatcher, append tool_result blocks, and
// re-fire the request. Capped at MAX_TOOL_TURNS to bound runaway.

import type { ChatMessage, ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_TURNS = 10;

// Tool input_schemas declared once per tool so AnthropicProvider +
// OpenAIProvider can share them. Mirror the args ToolDispatcher's
// handlers actually consume.
export const TOOL_SCHEMAS: Record<
  "read" | "grep" | "glob" | "list" | "bash",
  { description: string; input_schema: Record<string, unknown> }
> = {
  read: {
    description: "Read a file from the repo (relative to clone root). Output capped at 200KB.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "repo-relative path" } },
      required: ["path"],
    },
  },
  grep: {
    description: "Recursively search for a regex pattern in the repo. Returns lines with file:line prefix.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern" },
        path: { type: "string", description: "subdir to search (default: .)" },
      },
      required: ["pattern"],
    },
  },
  glob: {
    description: "Find files in the repo matching a glob pattern (e.g. **/*.ts).",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  list: {
    description: "List directory entries (one per line, dirs suffixed with /).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "repo-relative dir (default: .)" } },
    },
  },
  bash: {
    description: "Run a shell command from the curated allowlist (npm/npx/yarn/pnpm/bun/tsc/eslint/etc.). Bounded to 60s. NO chaining (`;`, `&&`), NO redirection (`>`, `<`), NO substitution ($(), backticks).",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

// Content blocks returned by Anthropic — text or tool_use.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface AnthropicStreamResult {
  blocks: ContentBlock[];
  stopReason: string | null;
  promptTokens: number;
  responseTokens: number;
  finishReason: "done" | "aborted" | "idle-timeout" | "error";
  errorMessage?: string;
}

export class AnthropicProvider implements SessionProvider {
  readonly id = "anthropic" as const;

  constructor(private readonly apiKey: string = process.env.ANTHROPIC_API_KEY ?? "") {}

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage: "ANTHROPIC_API_KEY not set",
      };
    }
    opts.logDiag?.({
      type: "_anthropic_call",
      agentId: opts.agentId,
      model: opts.model,
      promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
      tools: opts.tools?.length ?? 0,
      ts: t0,
    });

    const maxTokens = (opts.options?.max_tokens as number | undefined) ?? 8192;
    const useTools = !!(opts.tools && opts.tools.length > 0 && opts.dispatcher);

    // Build the running messages array. In Anthropic's API, content
    // can be a plain string (text-only) OR an array of content blocks
    // (mixing text + tool_use + tool_result). We start with strings
    // for the user-supplied prompt and switch to blocks once a tool
    // round-trip happens.
    type AnthroMessage = {
      role: "user" | "assistant";
      content: string | unknown[];
    };
    const messages: AnthroMessage[] = opts.messages.map((m) => ({
      role: m.role === "system" ? "user" : (m.role as "user" | "assistant"),
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

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const body = JSON.stringify({
        model: opts.model,
        max_tokens: maxTokens,
        stream: true,
        ...(opts.system ? { system: opts.system } : {}),
        messages,
        ...(tools ? { tools } : {}),
        ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
        ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
      });

      let resp: Response;
      try {
        resp = await fetch(ANTHROPIC_BASE, {
          method: "POST",
          signal: opts.signal,
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
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

      const turnResult = await readAnthropicStreamFull(resp.body, opts);
      cumulativePrompt += turnResult.promptTokens;
      cumulativeResponse += turnResult.responseTokens;

      // Concat any text blocks into the cumulative text.
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

      // If no tools or model didn't ask for any, we're done.
      const toolUses = turnResult.blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
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

      // Dispatch each tool, build tool_result blocks for the next turn.
      messages.push({ role: "assistant", content: turnResult.blocks });
      const toolResults: unknown[] = [];
      for (const t of toolUses) {
        const dispatchResult = await opts.dispatcher!.dispatch({
          tool: t.name as "read" | "grep" | "glob" | "list" | "bash",
          args: t.input,
        });
        const preview = dispatchResult.ok
          ? dispatchResult.output.slice(0, 80).replace(/\n/g, " ")
          : dispatchResult.error.slice(0, 80);
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

    // Hit the turn cap.
    return {
      text: cumulativeText,
      elapsedMs: Date.now() - t0,
      finishReason: "error",
      errorMessage: `Anthropic tool loop exceeded ${MAX_TOOL_TURNS} turns`,
      ...(cumulativePrompt + cumulativeResponse > 0
        ? { usage: { promptTokens: cumulativePrompt, responseTokens: cumulativeResponse } }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Stream readers — exported for tests.
// ---------------------------------------------------------------------------

/** Full reader: returns ContentBlock[] + stop_reason + token counts.
 *  Used by chat()'s multi-turn loop. */
export async function readAnthropicStreamFull(
  body: ReadableStream<Uint8Array>,
  opts: Pick<ChatOpts, "signal" | "idleTimeoutMs" | "firstChunkTimeoutMs" | "onChunk">,
): Promise<AnthropicStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stopReason: string | null = null;
  let promptTokens = 0;
  let responseTokens = 0;
  let firstChunkSeen = false;
  let lastChunkAt = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? 180_000;
  // Per content-block-index state. Anthropic streams blocks
  // out-of-order via index numbers; we accumulate per-index.
  const blockState = new Map<number, { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; inputJson: string }>();
  const t0 = Date.now();

  const checkTimeout = () => {
    const sinceLast = Date.now() - lastChunkAt;
    if (firstChunkSeen) return sinceLast >= idleTimeoutMs ? "idle-timeout" : null;
    return sinceLast >= firstChunkTimeoutMs ? "idle-timeout" : null;
  };

  let cumulativeText = "";

  while (true) {
    if (opts.signal.aborted) {
      return blocksFromState(blockState, stopReason, promptTokens, responseTokens, "aborted");
    }
    const timeoutReason = checkTimeout();
    if (timeoutReason) {
      return blocksFromState(blockState, stopReason, promptTokens, responseTokens, timeoutReason);
    }
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
      if (opts.signal.aborted) {
        return blocksFromState(blockState, stopReason, promptTokens, responseTokens, "aborted");
      }
      const result = blocksFromState(blockState, stopReason, promptTokens, responseTokens, "error");
      result.errorMessage = err instanceof Error ? err.message : String(err);
      return result;
    }
    if (chunk.done) break;
    if (chunk.value && chunk.value.length > 0) {
      lastChunkAt = Date.now();
      firstChunkSeen = true;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const json = dataLine.slice("data: ".length).trim();
        if (!json) continue;
        let ev: any;
        try { ev = JSON.parse(json); } catch { continue; }

        switch (ev.type) {
          case "message_start":
            if (ev.message?.usage?.input_tokens !== undefined) {
              promptTokens = ev.message.usage.input_tokens;
            }
            break;
          case "content_block_start": {
            const idx = ev.index as number;
            const cb = ev.content_block;
            if (cb?.type === "text") {
              blockState.set(idx, { type: "text", text: "" });
            } else if (cb?.type === "tool_use") {
              blockState.set(idx, {
                type: "tool_use",
                id: cb.id,
                name: cb.name,
                inputJson: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const idx = (ev.index as number) ?? 0;
            let state = blockState.get(idx);
            // Real Anthropic API ALWAYS emits content_block_start before
            // any delta. Synthetic / older test fixtures may skip it —
            // auto-create a text block in that case so we don't drop deltas.
            if (!state && ev.delta?.type === "text_delta") {
              state = { type: "text", text: "" };
              blockState.set(idx, state);
            }
            if (!state) break;
            if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string" && state.type === "text") {
              state.text += ev.delta.text;
              cumulativeText += ev.delta.text;
              opts.onChunk?.(cumulativeText);
            } else if (ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string" && state.type === "tool_use") {
              state.inputJson += ev.delta.partial_json;
            }
            break;
          }
          case "message_delta":
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens !== undefined) responseTokens = ev.usage.output_tokens;
            break;
        }
      }
    }
  }
  void t0;
  return blocksFromState(blockState, stopReason, promptTokens, responseTokens, "done");
}

function blocksFromState(
  blockState: Map<number, { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; inputJson: string }>,
  stopReason: string | null,
  promptTokens: number,
  responseTokens: number,
  finishReason: AnthropicStreamResult["finishReason"],
): AnthropicStreamResult {
  // Sort by index so blocks are returned in the order Anthropic emitted them.
  const indices = [...blockState.keys()].sort((a, b) => a - b);
  const blocks: ContentBlock[] = [];
  for (const i of indices) {
    const s = blockState.get(i)!;
    if (s.type === "text") {
      blocks.push({ type: "text", text: s.text });
    } else {
      let input: Record<string, unknown> = {};
      try { input = s.inputJson ? JSON.parse(s.inputJson) : {}; } catch { /* leave empty */ }
      blocks.push({ type: "tool_use", id: s.id, name: s.name, input });
    }
  }
  return { blocks, stopReason, promptTokens, responseTokens, finishReason };
}

/** Back-compat reader for the Phase 1 tests that returned just text + usage. */
export async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  opts: Pick<ChatOpts, "signal" | "idleTimeoutMs" | "firstChunkTimeoutMs" | "onChunk">,
  t0: number,
): Promise<ChatResult> {
  const result = await readAnthropicStreamFull(body, opts);
  let text = "";
  for (const b of result.blocks) {
    if (b.type === "text") text += b.text;
  }
  return {
    text,
    elapsedMs: Date.now() - t0,
    finishReason: result.finishReason,
    ...(result.promptTokens + result.responseTokens > 0
      ? { usage: { promptTokens: result.promptTokens, responseTokens: result.responseTokens } }
      : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}
