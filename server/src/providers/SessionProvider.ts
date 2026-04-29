// E3 Phase 1 (per docs/E3-drop-opencode-plan.md): one interface every
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
  /** Diagnostic logger — fires on call start + finish. */
  logDiag?: (record: unknown) => void;
  /** Optional correlation id for diag entries. */
  agentId?: string;
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
}

export interface SessionProvider {
  /** Provider identifier — matches the Provider type in shared/providers.ts. */
  readonly id: "ollama" | "anthropic" | "openai";
  /** Single round-trip chat call. Streaming is internal — the caller
   *  receives the assembled text on settle. Streaming hooks (incremental
   *  UI updates) come in a follow-up — Phase 1 is just the contract. */
  chat(opts: ChatOpts): Promise<ChatResult>;
}
