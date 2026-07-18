// E3 Phase 1 (commits d189f0d → 4190afe, 2026-04-29): one interface every
// LLM backend conforms to. Replaces the opencode-shaped
// `client.session.prompt(...)` call site so that future code can talk
// to Ollama / Anthropic / OpenAI without going through an opencode
// subprocess. Today only the new `pickProvider` factory uses this;
// runner wiring lands in Phase 2.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  /** Model id WITHOUT the provider prefix. The factory strips it before
   *  handing off; providers receive their bare id (e.g. "claude-opus-4-7"
   *  not "anthropic/claude-opus-4-7"). */
  model: string;
  /** System prompt — folded into the messages array per provider's
   *  preference. Anthropic takes it as a separate `system` field;
   *  OpenAI + Ollama prepend it as a system-role message. */
  system?: string;
  /** Conversation history ending with the prompt the model should
   *  respond to. */
  messages: ChatMessage[];
  /** Cancel the in-flight request. The fetch is aborted; the iterator
   *  ends with a "aborted" finishReason. */
  signal: AbortSignal;
  /** Steady-state ms with no body data before abort, measured AFTER
   *  the first chunk arrives. Default 60_000. */
  idleTimeoutMs?: number;
  /** Cold-start ms with no body data, t0 → first chunk. Default 180_000. */
  firstChunkTimeoutMs?: number;
  /** Optional per-call temperature etc. */
  options?: { temperature?: number; top_p?: number; [k: string]: unknown };
  /** Constrained-decoding schema. When set, the provider asks the model
   *  to emit output matching this JSON Schema (Ollama's `format` parameter,
   *  Anthropic's tool_use → input_schema, OpenAI's response_format
   *  json_schema). Ollama uses `format` directly; OpenAI/OpenCode chat
   *  use `response_format`; Anthropic uses `output_format` (structured
   *  outputs beta). Skipped when tools are active on the same call.
   *  Pass `"json"` for free-form JSON, or a JSON Schema object for strict
   *  emit-only planner/contract shapes. */
  format?: "json" | Record<string, unknown>;
  /** Diagnostic logger — fires on call start + finish. */
  logDiag?: (record: unknown) => void;
  /** Optional correlation id for diag entries. */
  agentId?: string;
  /** E3 Phase 3: streaming callback fired with cumulative text after
   *  every chunk. Keeps the UI's PersistentStreamBubble live in
   *  no-opencode mode where there's no SSE event stream to relay.
   *  Implementations call this synchronously inside the chunk loop. */
  onChunk?: (cumulativeText: string) => void;
  /** E3 Phase 4 part 2: list of tool names the agent may invoke.
   *  Each provider translates this to its own tool-definition shape
   *  (Anthropic input_schema, OpenAI function-call schema). Must be
   *  paired with `dispatcher` when set; the provider runs a multi-turn
   *  loop, dispatching tool calls through `dispatcher.dispatch(...)`
   *  and feeding results back to the model until it emits a text-only
   *  response (or hits a 10-turn safety cap). */
  tools?: ReadonlyArray<
    | "read"
    | "grep"
    | "glob"
    | "list"
    | "bash"
    | "write"
    | "edit"
    | "propose_hunks"
    | "git_status"
    | "git_diff"
    | "web_fetch"
    | "web_search"
  >;
  /** Required when `tools` is set. Owns the security-gated execution
   *  of each tool (profile permission table, path safety, allowlist
   *  for bash). See server/src/tools/ToolDispatcher.ts. */
  dispatcher?: import("../tools/ToolDispatcher.js").ToolDispatcher;
  /** Maximum model/tool round trips for this call. Defaults to 10;
   * explore profiles cap at EXPLORE_MAX_TOOL_TURNS (20) via promptWithRetry. */
  maxToolTurns?: number;
  /** Inject a user nudge before the Nth tool-loop turn (1-based). */
  toolLoopNudge?: { atTurn: number; message: string };
  /** Multiple nudges at different turns (merged with toolLoopNudge when set). */
  toolLoopNudges?: ReadonlyArray<{ atTurn: number; message: string }>;
  /** Hard wall-clock abort for the entire prompt (composed with caller signal). */
  promptWallClockMs?: number;
  /** Diagnostic callback fired for each tool invocation (name + result
   *  ok/error) so the UI can render tool-call timeline entries. */
  onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;

  /** runId for per-run isolation (proxy attribution, quota, usage, Brain). */
  runId?: string;
  /** Per-provider undici dispatcher for connection reuse and isolation. */
  httpDispatcher?: any;

  /** Marker that this LLM call is part of a brain-initiated run (for scheduling/priority). */
  brainInitiated?: boolean;

  /**
   * Ollama-native extras (api.md). **Only OllamaProvider / OllamaCloudProvider
   * read this.** OpenCodeProvider, AnthropicProvider, and OpenAIProvider must
   * ignore it so OpenCode models never receive Ollama-only fields.
   */
  ollama?: {
    think?: boolean | "low" | "medium" | "high" | "max";
    keepAlive?: string | number;
    /** Merged into Ollama `options` (num_ctx, num_predict, temperature, …). */
    options?: { temperature?: number; top_p?: number; [k: string]: unknown };
  };
}

export type FinishReason = "done" | "aborted" | "idle-timeout" | "error";

export interface ChatResult {
  /** Full assistant text — concatenation of every text chunk emitted. */
  text: string;
  /** Wall-clock ms from call start to settle. */
  elapsedMs: number;
  /** Why the call ended. */
  finishReason: FinishReason;
  /** Token counts when the provider surfaces them. */
  usage?: {
    promptTokens: number;
    responseTokens: number;
  };
  /** Provider-set error message when finishReason === "error". */
  errorMessage?: string;
  /** Original transport error — preserved for retry classification. */
  errorCause?: unknown;
}

export interface SessionProvider {
  /** Provider identifier — matches the Provider type in shared/providers.ts. */
  readonly id: "ollama" | "ollama-cloud" | "anthropic" | "openai" | "opencode";
  /** Single round-trip chat call. Streaming is internal — the caller
   *  receives the assembled text on settle. Streaming hooks (incremental
   *  UI updates) come in a follow-up — Phase 1 is just the contract. */
  chat(opts: ChatOpts): Promise<ChatResult>;
}
