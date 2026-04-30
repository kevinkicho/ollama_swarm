import { spawn, type ChildProcess } from "node:child_process";
// #234 (2026-04-27 evening): migrated v1 → v2 client. v2 has proper
// `format` typing (closes #233 for blackboard parser-strict prompts),
// deprecates the per-call `tools` field in favor of session-level
// permissions, and renames `path: { id }` → `sessionID` everywhere.
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config, basicAuthHeader } from "../config.js";
import { PortAllocator } from "./PortAllocator.js";
import { treeKill, killByPid, killByPort, isProcessAlive } from "./treeKill.js";
import { AgentPidTracker } from "./agentPids.js";
import type { AgentState, SwarmEvent } from "../types.js";
import { toOpenCodeModelRef } from "../../../shared/src/providers.js";
import { tokenTracker } from "./ollamaProxy.js";
import { createSession } from "./Session.js";

type Client = ReturnType<typeof createOpencodeClient>;

// Unit 17: minimal-token warmup prompt sent to each new agent right
// after spawn. Intentionally trivial — we don't care about the response
// content, only about loading model state on the cloud shard so the
// runner's first real prompt doesn't pay cold-start latency.
export const WARMUP_PROMPT_TEXT = "Reply with one word: ok";

// Phase 3 of #314: pure extractor — given a message.updated event's
// info payload, return a UsageRecord-shaped object when the message
// is a finished assistant turn from a non-Ollama provider with real
// token counts. Ollama is excluded because the proxy already captures
// it; double-counting would inflate the cost cap. Returns null in
// every other case so the caller's call site stays one branch.
export interface ExtractedUsage {
  ts: number;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
  model: string;
  path: string;
}

export function extractUsageFromMessageInfo(info: {
  role?: string;
  providerID?: string;
  modelID?: string;
  time?: { completed?: number };
  tokens?: { input?: number; output?: number };
}): ExtractedUsage | null {
  if (info.role !== "assistant") return null;
  if (!info.providerID || info.providerID === "ollama") return null;
  if (info.time?.completed === undefined) return null;
  const promptTokens = info.tokens?.input ?? 0;
  const responseTokens = info.tokens?.output ?? 0;
  if (promptTokens + responseTokens <= 0) return null;
  // Reconstruct the prefixed model string so CostTracker.detectProvider
  // works downstream. Fallback to providerID alone when modelID missing.
  const model = info.modelID ? `${info.providerID}/${info.modelID}` : info.providerID;
  return {
    ts: Date.now(),
    promptTokens,
    responseTokens,
    durationMs: 0,
    model,
    path: "/sdk-direct",
  };
}

export interface Agent {
  id: string;
  index: number;
  port: number;
  sessionId: string;
  client: Client;
  child?: ChildProcess;
  model: string;
  // Task #220: cwd captured from spawnOpts so respawnAgent can reconstruct
  // the same subprocess context after a crash. Without this, the respawn
  // path would need the BlackboardRunner to plumb clonePath through every
  // call site — much messier than just storing it on the Agent.
  cwd: string;
}

// Unit 41: killAll now reports whether every process was confirmed
// dead before it returned. Callers that want to surface this (e.g.
// POST /stop response) can read `escaped > 0` and warn; the older
// fire-and-forget callers can ignore it and behave exactly as before.
export interface KillAllResult {
  total: number;
  escaped: number;
}

// Task #166: in-flight stream-prompt accumulator state. Keyed by
// agent.id in AgentManager.streamingByAgent. Lifecycle:
//   - registered by streamPrompt() before firing the prompt
//   - text accumulated from message.part.updated SSE events
//   - per-chunk timeout reset on every text event
//   - resolved on session.idle for the agent's session
//   - rejected on per-chunk timeout, abort, or stream error
interface MessageStreamState {
  /** Latest cumulative text snapshot from message.part.updated. */
  text: string;
  lastChunkAt: number;
  /** Settler for the awaiter — resolves with assembled text. */
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  /** Per-chunk timeout — fires reject if no chunks for perChunkTimeoutMs. */
  timeoutHandle?: NodeJS.Timeout;
  perChunkTimeoutMs: number;
  /** AbortSignal listener cleanup. */
  signalCleanup?: () => void;
  /** Task #200: set by attachEventStream when its for-await loop exits
   *  WITHOUT session.idle having fired for this agent. Tells the HTTP
   *  catch handler that SSE is dead and the "lastChunkAt < 10s heuristic"
   *  is unreliable — propagate the HTTP error instead of swallowing. */
  sseStreamDied?: boolean;
  /** Task #196: format expectation forwarded from streamPrompt opts so
   *  the SSE-text handler can run an early format-sniff. */
  formatExpect?: "json" | "free";
  /** Task #196: idempotency flag — sniff fires at-most-once per call. */
  formatChecked?: boolean;
  /** 2026-04-27: messageRoles map size at stream_prompt_start. Used by
   *  the session.idle handler to distinguish a stale idle from the
   *  prior prompt's tail (warmup or earlier streamPrompt) vs the real
   *  idle for OUR prompt. opencode emits message.updated for the new
   *  user + assistant messages our prompt creates; messageRoles grows
   *  by 2 once those land. session.idle that fires with no growth (i.e.
   *  before our prompt's messages exist) is stale — ignore it. */
  initialRolesSize: number;
  /** 2026-04-27: set by handleSessionEvent when messageRoles size
   *  exceeds initialRolesSize, signaling that opencode has registered
   *  at least one new message for OUR prompt. session.idle is only
   *  honored once this is true. */
  sawNewMessage: boolean;
}

export interface StreamPromptOpts {
  agentName: string;
  modelID: string;
  promptText: string;
  signal: AbortSignal;
  /** Reject the stream if no text chunks arrive for this many ms.
   *  Per-chunk liveness signal — replaces undici's headersTimeout. */
  perChunkTimeoutMs: number;
  /** Task #196: when set to "json", abort early if the first
   *  EARLY_FORMAT_SNIFF_BYTES of streamed text contain neither `{`
   *  nor `[` nor a fenced ```json marker. Catches model-mismatch
   *  hallucinations (e.g. worker model handed a planner JSON prompt
   *  rambling markdown for ~14 minutes) within ~10s of streaming. */
  formatExpect?: "json" | "free";
  /** Phase 5b of #243: per-agent system-prompt addendum from the
   *  topology row. When set, prepended to promptText with an explicit
   *  framing header so the model treats it as additional context.
   *  Empty / undefined leaves the prompt untouched (pre-Phase-5
   *  behavior).
   *
   *  We prepend rather than using the SDK's `system` field because
   *  `system` REPLACES the agent profile's prompt (which carries the
   *  role-specific instructions like "you are a worker, return JSON").
   *  Prepending preserves the role prompt and adds the addendum on
   *  top — closer to what a thoughtful per-agent instruction would
   *  intuitively do. */
  promptAddendum?: string;
}

// Task #196: stream-text threshold for the format sniff. Set generously
// — many planner models emit a thinking-mode preamble (chain-of-thought
// reasoning) before the JSON. 2KB was too tight (false-positive on
// glm-5.1's planner reasoning, smoke run f26d7d0f, 2026-04-26). 8KB is
// large enough to accommodate the worst observed planner preamble while
// still aborting wrong-format hallucinations (e3738692 produced 29KB
// of markdown with zero JSON markers).
const EARLY_FORMAT_SNIFF_BYTES = 8192;

export interface SpawnOpts {
  cwd: string;
  index: number;
  model: string;
  readyTimeoutMs?: number;
  // Unit 18: when true, spawnAgent skips the auto-warmup baked in by
  // Unit 17. Caller is then responsible for warming the agent (typically
  // via warmupSerially after all spawns return). Used by runners that
  // want serial warmup across agents instead of the default parallel
  // pattern (where each parallel spawn does its own warmup concurrently
  // — the cloud can't load N shards in parallel for the same client).
  skipWarmup?: boolean;
}

const authedFetch: typeof fetch = async (input, init) => {
  // The SDK calls fetch with a Request object and no init. If we pass our own
  // init to fetch(Request, init), init.headers REPLACES the Request's headers
  // wholesale — nuking Content-Type and dropping the body's JSON framing. So
  // rebuild a new Request that inherits everything and just add the auth header.
  if (input instanceof Request && !init) {
    const headers = new Headers(input.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", basicAuthHeader());
    return fetch(new Request(input, { headers }));
  }
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("Authorization")) headers.set("Authorization", basicAuthHeader());
  return fetch(input, { ...init, headers });
};

export class AgentManager {
  private readonly ports = new PortAllocator();
  private readonly agents = new Map<string, Agent>();
  private readonly lastActivity = new Map<string, number>(); // sessionID -> ts
  private readonly eventAborts = new Map<string, AbortController>(); // agent.id -> abort
  private readonly rawSseCount = new Map<string, number>(); // agent.id -> count, for debug throttling
  // Unit 21: per-agent state mirror so toStates() can return current
  // statuses (retrying / failed / etc.) instead of the hardcoded "ready"
  // it returned pre-Unit-21. Updated in lockstep with every onState fire.
  // Keyed by agent.id; survives process exit so the REST snapshot still
  // shows the terminal status until killAll() clears.
  private readonly agentStates = new Map<string, AgentState>();
  // Unit 38: persistent PID tracking for orphan reclamation across
  // dev-server restarts. When present, AgentManager appends a record
  // per successful spawn and removes it on clean exit / killAll. When
  // absent (older callers / tests), PID tracking is a no-op — the
  // manager still works, orphans just don't get reclaimed.
  private readonly pidTracker?: AgentPidTracker;

  constructor(
    private readonly onState: (s: AgentState) => void,
    private readonly onEvent: (e: SwarmEvent) => void = () => {},
    // Diagnostic-only sink for records we don't want to broadcast over WS but
    // DO want in logs/current.jsonl (opencode stdout/stderr, raw SSE events).
    // Separate from onEvent to keep SwarmEvent honestly typed.
    private readonly logDiag: (record: unknown) => void = () => {},
    pidTracker?: AgentPidTracker,
  ) {
    this.pidTracker = pidTracker;
  }

  getLastActivity(sessionId: string): number | undefined {
    return this.lastActivity.get(sessionId);
  }

  touchActivity(sessionId: string, ts: number = Date.now()): void {
    this.lastActivity.set(sessionId, ts);
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.index - b.index);
  }

  // 2026-04-27: per-agent warmup elapsed (ms). undefined when warmup
  // hasn't completed yet OR was skipped at spawn. Runners read this
  // when assembling the agents_ready summary so the UI can show
  // cold-start cost per agent without grepping the diag log.
  getWarmupElapsedMs(agentId: string): number | undefined {
    return this.warmupElapsedByAgent.get(agentId);
  }

  // Task #166: stream-aware replacement for `await agent.client.session.prompt(...)`.
  // Fires the prompt with `noReply: true` (server doesn't block on the response),
  // then accumulates text from the existing SSE event stream until session.idle
  // for the agent's session. Per-chunk timeout fires reject if no text arrives
  // for opts.perChunkTimeoutMs — that's the real liveness signal, replacing
  // undici's 5-min headersTimeout that was wedging on heavy prompts.
  //
  // Returns the assembled text directly (not the SDK response shape — callers
  // that previously used extractText(res) on the prompt-response can just use
  // this string directly).
  //
  // Why this works:
  //   - SSE stream is already subscribed in attachEventStream() per agent
  //   - handleSessionEvent already fans message.part.updated text events to
  //     UI via agent_streaming; we add a parallel fan-out to the
  //     streamingByAgent accumulator
  //   - session.idle reliably terminates because each agent's session has
  //     at most one in-flight prompt at a time (our serial usage pattern)
  async streamPrompt(agent: Agent, opts: StreamPromptOpts): Promise<string> {
    // Task #223: track per-agent prompt count so diag logs distinguish
    // 1st vs 2nd+ prompts (the wedge in run 68b76b79 hit on the 4th
    // prompt to agent-3 — first 3 succeeded normally).
    const promptN = (this.streamPromptCount.get(agent.id) ?? 0) + 1;
    this.streamPromptCount.set(agent.id, promptN);
    // 2026-04-27: cold-start tolerance. The first prompt to an agent
    // can hit a multi-minute first-byte tail on heavy reasoning models
    // (deepseek-v4-pro: observed ≥60s, see run 0254ca7c). Default 90s
    // per-chunk fires too eagerly on those. Double it for promptN === 1
    // so cold-start completes; steady-state (promptN ≥ 2) keeps the
    // sharper 90s signal. Caller can still override via opts.perChunkTimeoutMs.
    const effectivePerChunkTimeoutMs =
      promptN === 1 ? Math.max(opts.perChunkTimeoutMs, 180_000) : opts.perChunkTimeoutMs;
    this.logDiag({
      type: "_stream_prompt_start",
      agentId: agent.id,
      promptN,
      perChunkTimeoutMs: effectivePerChunkTimeoutMs,
      coldStartBoosted: promptN === 1 && effectivePerChunkTimeoutMs > opts.perChunkTimeoutMs,
      ts: Date.now(),
    });
    // One in-flight stream per agent. If a prior call somehow leaked,
    // reject it so its awaiter unblocks rather than wedging forever.
    const prior = this.streamingByAgent.get(agent.id);
    if (prior) {
      prior.reject(new Error("superseded by new streamPrompt call"));
      if (prior.timeoutHandle) clearTimeout(prior.timeoutHandle);
      prior.signalCleanup?.();
    }

    // 2026-04-27: snapshot messageRoles size BEFORE the new prompt fires.
    // session.idle handler uses this to filter out stale idles arriving
    // from a prior session.prompt's tail (warmup or earlier streamPrompt).
    // See MessageStreamState.initialRolesSize for full reasoning.
    const initialRolesSize = this.messageRoles.get(agent.id)?.size ?? 0;
    return new Promise<string>((resolve, reject) => {
      const state: MessageStreamState = {
        text: "",
        lastChunkAt: Date.now(),
        resolve,
        reject,
        perChunkTimeoutMs: effectivePerChunkTimeoutMs,
        formatExpect: opts.formatExpect,
        initialRolesSize,
        sawNewMessage: false,
      };
      const armChunkTimeout = () => {
        if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
        state.timeoutHandle = setTimeout(() => {
          // Task #223 diag: log every time the per-chunk timer fires.
          // Lets us confirm the timer IS armed and firing for 2nd+
          // prompts. Run 68b76b79 had ZERO probe events for agent-3's
          // 4th prompt — either timer wasn't armed or never fired.
          this.logDiag({
            type: "_stream_chunk_timeout_fired",
            agentId: agent.id,
            promptN,
            sinceLastChunkMs: Date.now() - state.lastChunkAt,
            currentTextChars: state.text.length,
            ts: Date.now(),
          });
          // Task #192: silence ≠ death. Before rejecting, probe the
          // session via REST. If the latest assistant message has
          // grown since our last SSE chunk, the SSE channel is broken
          // but the model is still producing — reset the timer and
          // backfill any missed text. Only reject if the probe also
          // shows no growth (genuinely stuck).
          this.probeAndDecide(agent, state, armChunkTimeout, reject).catch((probeErr) => {
            // Probe itself failed — fall back to the original behavior
            // (reject as if no SSE chunks). Logged for diagnosis.
            const cur = this.streamingByAgent.get(agent.id);
            if (cur !== state) return; // already settled
            this.streamingByAgent.delete(agent.id);
            state.signalCleanup?.();
            reject(new Error(
              `per-chunk timeout: no SSE chunks for ${effectivePerChunkTimeoutMs}ms ` +
              `(probe also failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)})`,
            ));
          });
        }, effectivePerChunkTimeoutMs);
      };
      const onAbort = () => {
        const cur = this.streamingByAgent.get(agent.id);
        if (cur === state) this.streamingByAgent.delete(agent.id);
        if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
        reject(new Error("aborted"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      state.signalCleanup = () => opts.signal.removeEventListener("abort", onAbort);
      armChunkTimeout();
      this.streamingByAgent.set(agent.id, state);
      // Override resolve/reject to also clean up signal listener.
      const wrappedResolve = (text: string) => {
        state.signalCleanup?.();
        if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
        resolve(text);
      };
      const wrappedReject = (err: Error) => {
        state.signalCleanup?.();
        if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
        reject(err);
      };
      state.resolve = wrappedResolve;
      state.reject = wrappedReject;

      // Fire the prompt asynchronously. noReply=true means the server
      // We `void` (don't await) the SDK call so its HTTP duration
      // doesn't matter to us — SSE events drive completion via
      // session.idle. The underlying HTTP request may still take 5+
      // min on heavy prompts, but we'll have resolved long before.
      //
      // Note: we tried `noReply: true` initially (intended to make the
      // server release the HTTP early) but observed that with noReply
      // OpenCode skips emitting message.part.updated events for our
      // setup — every prompt 90s-timed-out with zero chunks. So we
      // fire the regular prompt; the HTTP body just goes unread.
      // Phase 5b of #243: per-agent prompt addendum from topology row.
      // Prepended with a clear framing block so the model treats it
      // as additional standing instructions on top of the role-level
      // system prompt (which lives in the agent profile and is
      // preserved). Empty addendum → text passes through unchanged.
      const effectivePromptText =
        opts.promptAddendum && opts.promptAddendum.trim().length > 0
          ? `[Per-agent specialization for this swarm member]\n${opts.promptAddendum.trim()}\n[End specialization. Original prompt follows.]\n\n${opts.promptText}`
          : opts.promptText;
      void agent.client.session.prompt(
        {
          sessionID: agent.sessionId,
          agent: opts.agentName,
          model: toOpenCodeModelRef(opts.modelID),
          parts: [{ type: "text", text: effectivePromptText }],
        },
        { signal: opts.signal },
      ).catch((err) => {
        // Task #170 fix: when streaming via SSE, HTTP-level errors
        // (UND_ERR_HEADERS_TIMEOUT in particular) are NOISE if SSE has
        // been actively delivering events. The OpenCode HTTP path
        // doesn't send response headers until generation completes —
        // on a heavy 10+ min prompt, undici's headersTimeout will
        // fire even though SSE chunks are flowing fine. SSE is the
        // source of truth in streaming mode; the HTTP error is just
        // a side-channel signal.
        //
        // Heuristic: if we received any SSE chunk within the last
        // 10 seconds (lastChunkAt was just bumped by the SSE handler),
        // ignore the HTTP error. Per-chunk timeout (default 90s) is
        // the real liveness signal — if SSE then goes silent, that
        // path will reject. Otherwise session.idle resolves us.
        //
        // Only reject from the HTTP catch when SSE has ALSO been
        // silent — that's a true failure (e.g. auth, network).
        const cur = this.streamingByAgent.get(agent.id);
        if (cur !== state) return; // already settled
        // Task #200: if SSE channel died (for-await loop exited without
        // session.idle), the lastChunkAt heuristic is unreliable — last
        // chunks may have arrived very recently right before the channel
        // dropped. Propagate the HTTP error instead of waiting for the
        // per-chunk timer that will never fire because no events are
        // arriving anymore.
        if (state.sseStreamDied) {
          this.streamingByAgent.delete(agent.id);
          wrappedReject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const sinceLastChunk = Date.now() - state.lastChunkAt;
        if (sinceLastChunk < 10_000) {
          // SSE is live; trust the per-chunk timer + session.idle
          // to drive completion. Don't reject from HTTP side.
          return;
        }
        this.streamingByAgent.delete(agent.id);
        wrappedReject(err instanceof Error ? err : new Error(String(err)));
      });
      // armChunkTimeout above kicks in immediately — gives us a "request
      // never produced any chunk" signal even before any SSE event.
    });
  }

  // Task #192: when the per-chunk SSE timer fires, probe the session
  // via REST before declaring death. If the latest assistant message
  // has grown beyond what we've seen via SSE, the SSE delivery channel
  // is broken — backfill the missed text, reset the per-chunk timer,
  // and keep waiting. Only reject if the model is genuinely silent.
  //
  // This decouples "SSE channel health" from "model health" — they're
  // two independent failure modes that previously both presented as
  // "no chunks in 90s = abort".
  private async probeAndDecide(
    agent: Agent,
    state: MessageStreamState,
    armChunkTimeout: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    // Re-check we're still the in-flight stream — caller may have
    // settled us between timer fire and this microtask.
    if (this.streamingByAgent.get(agent.id) !== state) return;

    let probeText: string | null = null;
    try {
      const res = await agent.client.session.messages({ sessionID: agent.sessionId });
      probeText = extractLatestAssistantText(res);
    } catch (err) {
      // REST probe failed — fall back to "treat as dead". Caller's
      // .catch handles the reject path.
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Re-check after the await — anything could have changed.
    if (this.streamingByAgent.get(agent.id) !== state) return;

    if (probeText !== null && probeText.length > state.text.length) {
      // Model is alive; SSE channel is broken. Backfill the chars we
      // missed, reset the per-chunk timer, and keep waiting. Surface
      // to the diag log so we know SSE is unhealthy on this agent.
      const gained = probeText.length - state.text.length;
      state.text = probeText;
      state.lastChunkAt = Date.now();
      this.logDiag({
        type: "_sse_probe_recovery",
        agentId: agent.id,
        ourSessionId: agent.sessionId,
        backfilledChars: gained,
        totalChars: probeText.length,
        promptN: this.streamPromptCount.get(agent.id) ?? 0,
      });
      armChunkTimeout();
      return;
    }
    // Task #223: log when probe confirms silence (about to reject).
    // Distinguishes "subprocess actually silent" from "probe failed".
    this.logDiag({
      type: "_sse_probe_silence",
      agentId: agent.id,
      ourSessionId: agent.sessionId,
      currentTextChars: state.text.length,
      probeTextChars: probeText?.length ?? -1,
      promptN: this.streamPromptCount.get(agent.id) ?? 0,
    });

    // Probe agrees with SSE: model is silent. Reject as before.
    this.streamingByAgent.delete(agent.id);
    state.signalCleanup?.();
    reject(new Error(`per-chunk timeout: no SSE chunks for ${state.perChunkTimeoutMs}ms (probe confirmed silence)`));
  }

  // Task #191: lastChunkAt accessor so BlackboardRunner's ABSOLUTE_MAX_MS
  // watchdog can consult SSE liveness before firing. The existing per-
  // chunk timeout (90s) is the inner liveness check; the outer 1200s
  // wall-clock cap should yield to it when SSE is healthy.
  getLastChunkAt(agentId: string): number | undefined {
    return this.streamingByAgent.get(agentId)?.lastChunkAt;
  }

  // Task #194: after the SSE stream auto-reconnects, fetch the current
  // session state via REST and backfill any text we missed during the
  // gap. Without this, late chunks that arrived between disconnect and
  // reconnect are lost forever (SSE has no replay).
  private async reconcileAfterReconnect(agent: Agent): Promise<void> {
    const stream = this.streamingByAgent.get(agent.id);
    if (!stream) return; // no in-flight prompt to reconcile
    const res = await agent.client.session.messages({ sessionID: agent.sessionId });
    const probeText = extractLatestAssistantText(res);
    if (probeText !== null && probeText.length > stream.text.length) {
      const gained = probeText.length - stream.text.length;
      stream.text = probeText;
      stream.lastChunkAt = Date.now();
      this.logDiag({
        type: "_sse_reconnect_backfill",
        agentId: agent.id,
        ourSessionId: agent.sessionId,
        backfilledChars: gained,
        totalChars: probeText.length,
      });
    }
  }

  toStates(): AgentState[] {
    // Unit 21: returns actual current state per agent (may be
    // "thinking" / "retrying" / "failed" / "stopped"), not the
    // hardcoded "ready" we returned pre-Unit-21. Sorted by index for
    // deterministic UI ordering.
    return [...this.agentStates.values()].sort((a, b) => a.index - b.index);
  }

  // Task #222: returns true if any agent is currently in flight on a
  // prompt. Used by the worker-wedge diag to suppress false-positive
  // alarms when sibling workers are correctly waiting on a slow-but-
  // alive worker. The wedge is for the case where ALL agents are idle
  // but the board still has claimed work — that's when something is
  // truly stuck. With one agent thinking, "claimed > 0" is normal.
  anyAgentThinking(): boolean {
    for (const s of this.agentStates.values()) {
      if (s.status === "thinking" || s.status === "retrying") return true;
    }
    return false;
  }

  // Unit 21: single source-of-truth helper for state changes. Mirrors
  // the broadcast onState callback AND updates the agentStates map so
  // toStates() (which feeds REST /api/swarm/status and WS catch-up)
  // stays consistent with the WS event stream. Every callsite that
  // used to call `this.onState(s)` directly now calls this.
  private setAgentState(s: AgentState): void {
    this.agentStates.set(s.id, s);
    this.onState(s);
  }

  // E3 Phase 3 (slice): construct an Agent without spawning an opencode
  // subprocess. The returned agent has a stubbed `client` that throws
  // on use — any caller that still touches agent.client.session.* in
  // no-opencode mode is a logic bug that should fail loud, not fall
  // back silently to opencode behavior.
  //
  // Today only BaselineRunner uses this. killAll handles agent.child=
  // undefined gracefully (the existing `agent.child?.pid` chain).
  async spawnAgentNoOpencode(opts: SpawnOpts): Promise<Agent> {
    const id = `agent-${opts.index}`;
    const session = createSession(opts.model);
    const port = 0; // sentinel — no real port allocated
    const stateBase: AgentState = {
      id,
      index: opts.index,
      port,
      status: "ready",
      sessionId: session.id,
    };
    this.setAgentState(stateBase);
    // Stub the client so any unmigrated call site fails loud.
    const stubClient = new Proxy(
      {},
      {
        get() {
          throw new Error(
            "AgentManager.spawnAgentNoOpencode: agent.client is not available in no-opencode mode. " +
              "This caller still depends on the opencode SDK; route it through pickProvider instead.",
          );
        },
      },
    ) as unknown as Client;
    const agent: Agent = {
      id,
      index: opts.index,
      port,
      sessionId: session.id,
      client: stubClient,
      child: undefined,
      model: opts.model,
      cwd: opts.cwd,
    };
    this.agents.set(id, agent);
    return agent;
  }

  // E3 Phase 5 (2026-04-29): legacy SDK-spawning body removed. Every
  // call now delegates to spawnAgentNoOpencode. Existing callers that
  // still use spawnAgent (and the conditional spawnFn pattern in the
  // 9 runners) keep working — both branches now do the same thing.
  // Future cleanup can remove the conditionals and rename the method.
  async spawnAgent(opts: SpawnOpts): Promise<Agent> {
    return this.spawnAgentNoOpencode(opts);
  }

  // Task #220: cheap liveness check used by callers (BlackboardRunner)
  // before firing a high-cost prompt to detect a dead subprocess and
  // trigger respawn. Hits the OpenCode subprocess's `/doc` endpoint —
  // the same endpoint waitForReady uses for spawn-time readiness, which
  // proves it exists on every opencode subprocess. (Initial b6d91d13
  // implementation tried `/api/health` which is OUR dev-server endpoint,
  // NOT opencode's — every ping returned 404, every planner call
  // triggered needless respawn.) Short 1.5s timeout via authedFetch;
  // falls through to false on any error so callers default to respawn.
  async pingAgentHealth(agent: Agent): Promise<boolean> {
    try {
      const res = await Promise.race([
        authedFetch(`http://127.0.0.1:${agent.port}/doc`),
        new Promise<Response>((_, rej) =>
          setTimeout(() => rej(new Error("health-check timeout")), 1500),
        ),
      ]);
      return res.ok;
    } catch {
      return false;
    }
  }

  // Task #220: tear down ONE agent without affecting siblings. Used by
  // respawnAgent to clean up the dead subprocess before spawning fresh.
  // killAll's full cleanup is too coarse here — it nukes every agent.
  async killOneAgent(agent: Agent): Promise<void> {
    // Cancel SSE event stream first so its for-await loop doesn't keep
    // reconnecting to the dying port.
    const abort = this.eventAborts.get(agent.id);
    if (abort) {
      abort.abort();
      this.eventAborts.delete(agent.id);
    }
    // Reject any in-flight stream promise so callers unwedge.
    const stream = this.streamingByAgent.get(agent.id);
    if (stream) {
      if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);
      stream.signalCleanup?.();
      stream.reject(new Error("agent respawning"));
      this.streamingByAgent.delete(agent.id);
    }
    // Drop per-agent buffers so the respawned subprocess starts clean.
    this.partialStreams.delete(agent.id);
    this.partsByAgent.delete(agent.id);
    this.messageRoles.delete(agent.id);
    this.capturedUsageMessageIds.delete(agent.id);
    this.suppressStreamingFor.delete(agent.id);
    this.rawSseCount.delete(agent.id);
    const flushTimer = this.streamingFlushTimers.get(agent.id);
    if (flushTimer) clearTimeout(flushTimer);
    this.streamingFlushTimers.delete(agent.id);
    this.latestStreamingText.delete(agent.id);
    // Kill the child process tree.
    if (agent.child) {
      try {
        await treeKill(agent.child);
      } catch {
        // best-effort
      }
    }
    // Release port + drop registry entry. Port may already be released
    // by child.on("exit") handler — release() is idempotent.
    this.ports.release(agent.port);
    this.agents.delete(agent.id);
  }

  // Task #220: respawn an agent with the same identity (id, index, model,
  // role) after its subprocess has died. Allocates a new port, spawns a
  // fresh OpenCode subprocess, creates a new session. Returns the new
  // Agent — caller must replace its reference (e.g., this.planner).
  //
  // Why not just call spawnAgent directly: respawn must (a) tear down
  // the dead subprocess first via killOneAgent, (b) preserve the agent's
  // role-specific cwd and model, (c) emit clear lifecycle messages so the
  // user sees what's happening rather than a silent ID swap.
  async respawnAgent(agent: Agent): Promise<Agent> {
    const oldId = agent.id;
    // 2026-04-27: drop prior warmup elapsed so spawnAgent's fresh
    // warmup overwrites cleanly (rather than coexisting with stale).
    this.warmupElapsedByAgent.delete(oldId);
    await this.killOneAgent(agent);
    const fresh = await this.spawnAgent({
      cwd: agent.cwd,
      index: agent.index,
      model: agent.model,
      // skipWarmup=false → warmup the fresh subprocess so the next
      // real prompt isn't cold.
    });
    // spawnAgent reuses the agent.id derived from index, so the
    // respawned agent has the SAME id as the original. Sanity check.
    if (fresh.id !== oldId) {
      throw new Error(
        `respawn id mismatch: expected ${oldId} got ${fresh.id} (index reuse broke?)`,
      );
    }
    return fresh;
  }

  // Unit 18: warm a batch of agents one at a time. Used by runners
  // that pass skipWarmup:true to spawnAgent and then warm explicitly
  // after the parallel spawn batch returns. Serial warmup loads cloud
  // shards one-by-one, working around the cloud load balancer's
  // apparent inability to load N shards in parallel for the same
  // client (battle test v3 showed parallel warmups didn't help
  // map-reduce, council, OW — same outcome as no warmup at all).
  async warmupSerially(agents: readonly Agent[]): Promise<void> {
    if (!config.AGENT_WARMUP_ENABLED) return;
    for (const a of agents) {
      await this.warmupAgent(a);
    }
  }

  // Unit 18: warm a batch of agents in parallel. Used by parallel-fan-out
  // runners (council/OW/map-reduce) immediately before each runner's
  // FIRST parallel real-turn batch. The cloud handles N parallel small
  // prompts (warmup) better than N parallel large prompts (real turns
  // with full transcript), so paying the parallel cold-start cost on
  // small prompts spares the real batch from the same penalty.
  async warmupParallel(agents: readonly Agent[]): Promise<void> {
    if (!config.AGENT_WARMUP_ENABLED) return;
    await Promise.allSettled(agents.map((a) => this.warmupAgent(a)));
  }

  // Unit 17: send a trivial prompt to the agent right after spawn so
  // the cloud shard loads model state BEFORE the runner asks for real
  // work. Cuts the cold-start tail that bumping headersTimeout 90→180s
  // (Unit 16) couldn't fully cover. Non-fatal — if warmup itself fails
  // (headers timeout, network blip) we log it and proceed; the next
  // real prompt has at minimum told the cloud shard we exist.
  // Unit 18: made public so runners can call it explicitly via
  // warmupSerially / warmupParallel after a parallel spawn batch.
  async warmupAgent(agent: Agent): Promise<void> {
    const t0 = Date.now();
    // Task #181: hide warmup bubbles from UI. The "ok" response
    // appearing as a streaming chat bubble is noise; the existing
    // "Worker agent X ready on port Y" system message already
    // communicates readiness more cleanly.
    this.suppressStreamingFor.add(agent.id);
    try {
      await agent.client.session.prompt({
        sessionID: agent.sessionId,
        agent: "swarm",
        model: toOpenCodeModelRef(agent.model),
        parts: [{ type: "text", text: WARMUP_PROMPT_TEXT }],
      });
      const elapsed = Date.now() - t0;
      this.warmupElapsedByAgent.set(agent.id, elapsed);
      this.logDiag({ type: "_warmup_ok", agentId: agent.id, elapsedMs: elapsed });
    } catch (err) {
      const msg = stringifyError(err);
      this.logDiag({
        type: "_warmup_failed",
        agentId: agent.id,
        elapsedMs: Date.now() - t0,
        error: msg,
      });
      // Intentional swallow — warmup is best-effort. The runner's first
      // real prompt will retry through the Unit 16 wrapper if needed.
    } finally {
      // Task #181: clear suppression so subsequent real prompts on
      // this agent flow through to the UI normally.
      this.suppressStreamingFor.delete(agent.id);
    }
  }

  markStatus(id: string, status: AgentState["status"], extra: Partial<AgentState> = {}): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setAgentState({ id, index: a.index, port: a.port, sessionId: a.sessionId, status, ...extra });
  }

  // thinkingSince REST-snapshot fix (bundled with Unit 56b/57 cleanup
  // batch 2026-04-23): runners that previously bypassed the manager
  // and emitted agent_state events directly via `opts.emit` left the
  // manager's `agentStates` mirror stale. The REST /api/swarm/status
  // snapshot reads from that mirror, so fields like Unit 39's
  // `thinkingSince` only appeared on the live WS stream — fresh page
  // loads + WS catch-up never saw them. This passthrough lets runners
  // route their direct emits through the same single source of truth
  // setAgentState writes to (mirror + broadcast in lockstep).
  recordAgentState(s: AgentState): void {
    this.setAgentState(s);
  }

  // Improvement #4 from 2026-04-23 retro: per-agent first-prompt
  // (cold-start) latency tracking. The "Agent N starvation" pattern
  // has shifted across runs (agent-2 in v6, agent-2+3 in v7,
  // agent-3 empty responses on the preset tour). Whichever agent
  // index lands in the degraded queue slot under cloud fanout has
  // varied — so we want per-agent first-byte timing on the FIRST
  // prompt only, where the cold-start cost is concentrated.
  //
  // Runners call this after every promptWithRetry timing. The first
  // call per agent emits a "cold_start" diag record; subsequent
  // calls are no-ops here (the per-attempt timing already lands
  // through onTiming).
  private firstPromptLogged = new Set<string>();
  // 2026-04-27: per-agent warmup elapsedMs, populated on _warmup_ok.
  // Surfaced via getWarmupElapsedMs so runners can include it in the
  // "agents_ready" structured summary. Cleared on respawn + killAll.
  private warmupElapsedByAgent = new Map<string, number>();

  // Task #39: per-agent partial-stream buffer. Updated on every
  // `message.part.updated` event with text content; cleared on
  // `session.idle` (stream finalized) and on killAll (run end).
  // getPartialStreams() returns a snapshot for the REST catch-up.
  private partialStreams = new Map<string, { text: string; updatedAt: number }>();

  // Task #166: per-agent in-flight stream-prompt accumulator. When
  // promptWithRetry uses streamPrompt() instead of the blocking
  // session.prompt(), we register state here keyed by agent.id —
  // the SSE handler accumulates text from message.part.updated
  // events and resolves the promise on session.idle. Per-chunk
  // timeout fires if no chunks arrive for perChunkTimeoutMs (cheap
  // liveness signal that replaces undici's 5-min headersTimeout).
  // Only one in-flight stream per agent at a time — matches our
  // serial usage (each agent's session is single-message-in-flight).
  private streamingByAgent = new Map<string, MessageStreamState>();
  // Task #223: per-agent prompt count for diag tracing. Increments
  // every time streamPrompt is called. Used to distinguish 1st vs
  // 2nd+ prompts in _stream_prompt_start / _stream_chunk_timeout_fired
  // / _sse_probe_recovery diag entries.
  private streamPromptCount = new Map<string, number>();
  // Task #172: trailing-edge throttle for agent_streaming WS events.
  // SSE text snapshots arrive every ~50ms during model output; emitting
  // each one to the UI causes "vibrating text" (full re-render) and
  // wasted WS bandwidth. Coalesce to ~10/sec by buffering the latest
  // text and flushing once per STREAMING_THROTTLE_MS window.
  // Flushed immediately on session.idle so the final state lands
  // before agent_streaming_end fires.
  private streamingFlushTimers = new Map<string, NodeJS.Timeout>();
  private latestStreamingText = new Map<string, string>();
  // Task #174: per-(agent,part) text accumulator. OpenCode emits
  // MULTIPLE text parts per message (e.g. an initial 29-char echo
  // part, then the actual N-thousand-char response part). Each part
  // has its own cumulative `text` field that starts at 0 — naively
  // setting agent.text = part.text wipes prior parts when a new
  // part arrives. Tracking per-partId fixes the "streaming text
  // suddenly goes empty mid-response" bug.
  // Map: agentId → Map<partId, text>. Insertion order = display order.
  private partsByAgent = new Map<string, Map<string, string>>();
  // Task #179 (was #175): per-agent map of messageID → role. OpenCode
  // emits message.part.updated for BOTH the user's prompt-message parts
  // AND the assistant's response-message parts; without explicit
  // role filtering, the per-part text accumulator concatenates the
  // system+user prompt INTO the response (we saw 27K-char "responses"
  // starting with "You are the PLANNER..." that never parsed as JSON).
  //
  // The original #175 fix tracked only `currentAssistantMsgId` and
  // accepted any part whose messageID matched. Bug: when user-message
  // parts fire BEFORE the assistant message.updated event sets
  // assistantMsgId (race), the early user parts leaked through
  // because the filter short-circuited on undefined assistantMsgId.
  //
  // #179 fix: track ALL known message roles. Parts are only accepted
  // when their messageID is EXPLICITLY known to be "assistant" — user
  // and unknown-role parts both reject. Roles populate from
  // message.updated events; cleared on session.idle along with the
  // per-part accumulator.
  private messageRoles = new Map<string, Map<string, "user" | "assistant">>();
  // Phase 3 of #314: dedupe usage capture for paid providers. opencode
  // emits message.updated multiple times during streaming — we only
  // record once per message id, when time.completed is set. Cleared on
  // session.idle along with messageRoles + partsByAgent.
  private capturedUsageMessageIds = new Map<string, Set<string>>();
  // Task #181: when an agent.id is in this set, all UI-facing streaming
  // events (agent_streaming, agent_streaming_end) are suppressed, the
  // partialStreams REST catch-up buffer is not populated, and the
  // _stream_complete diagnostic is skipped. Used for warmup pings —
  // their "ok" responses are noise next to the existing "Worker agent
  // X ready on port Y" system message that already signals readiness.
  // Set by warmupAgent for the duration of the warmup prompt only.
  private suppressStreamingFor = new Set<string>();

  recordPromptComplete(
    agentId: string,
    info: { attempt: number; elapsedMs: number; success: boolean },
  ): void {
    if (this.firstPromptLogged.has(agentId)) return;
    this.firstPromptLogged.add(agentId);
    const agent = this.agents.get(agentId);
    this.logDiag({
      type: "cold_start",
      agentId,
      agentIndex: agent?.index,
      port: agent?.port,
      model: agent?.model,
      attempt: info.attempt,
      elapsedMs: info.elapsedMs,
      success: info.success,
      ts: Date.now(),
    });
  }

  async killAll(): Promise<KillAllResult> {
    for (const ctrl of this.eventAborts.values()) ctrl.abort();
    this.eventAborts.clear();
    let escaped = 0;
    const tasks = [...this.agents.values()].map(async (a) => {
      // Bug: a hung opencode subprocess can leave session.abort() pending
      // forever (HTTP request never returns), wedging killAll and blocking
      // every subsequent run with phase=stopping. Race the abort against a
      // 5s timeout so worst-case we proceed to the kill chain regardless.
      // Found 2026-04-28 during the 9-preset tour after debate-judge
      // hung post-run; orchestrator stayed in `stopping` 18+ minutes.
      try {
        await Promise.race([
          a.client.session.abort({ sessionID: a.sessionId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("session.abort timeout 5s")), 5000),
          ),
        ]);
      } catch {
        // ignore — fall through to treeKill / killByPid / killByPort
      }
      treeKill(a.child);
      // Unit 41 + Task #122: verified kill with three-stage escalation.
      // We do NOT return until every PID we spawned is confirmed dead,
      // OR we have exhausted all stages. The /stop route awaits this.
      //
      // Stage 1 (up to 3 s): treeKill via ChildProcess, poll every
      //   300 ms with one retry at the 0.9 s mark.
      // Stage 2 (up to 3 s): killByPid (direct taskkill /F /PID or
      //   SIGTERM→SIGKILL on POSIX), poll every 300 ms. Bypasses the
      //   ChildProcess handle — catches cases where the Windows shell
      //   wrapper died but its opencode grandchild is still holding a
      //   port.
      // Stage 3 (Task #122, up to 3 s): killByPort. The opencode
      //   binary actually exec()s through a launcher that exits
      //   within seconds — the captured child.pid is dead, but a
      //   different node PID owns the port. Look up the actual
      //   listener PID and kill it. This is what was leaking the
      //   most orphans before.
      // If all stages fail the PID is counted as "escaped" and the
      // startup orphan sweep remains the safety net.
      const pid = a.child?.pid;
      if (pid !== undefined) {
        let dead = !isProcessAlive(pid);
        for (let i = 0; i < 10 && !dead; i++) {
          await new Promise((r) => setTimeout(r, 300));
          if (!isProcessAlive(pid)) { dead = true; break; }
          if (i === 2) treeKill(a.child); // retry treeKill at 0.9 s
        }
        if (!dead) {
          killByPid(pid);
          for (let i = 0; i < 10 && !dead; i++) {
            await new Promise((r) => setTimeout(r, 300));
            if (!isProcessAlive(pid)) { dead = true; break; }
            if (i === 2) killByPid(pid); // retry killByPid at 0.9 s
          }
        }
        // Task #122: stage 3 — port-based escalation. Always run when
        // the port is still listening, even if `dead` claims true (the
        // tracked PID is dead but a different process can still hold
        // the port — common with opencode launchers).
        const portKilled = killByPort(a.port);
        if (portKilled.length > 0) {
          // Wait for port-targeted PIDs to die.
          let allPortDead = false;
          for (let i = 0; i < 10 && !allPortDead; i++) {
            await new Promise((r) => setTimeout(r, 300));
            allPortDead = portKilled.every((p) => !isProcessAlive(p));
            if (i === 2 && !allPortDead) {
              for (const p of portKilled) killByPid(p);
            }
          }
          if (!allPortDead) escaped += 1;
          else dead = true; // count as cleaned up
        } else if (!dead) {
          escaped += 1;
        }
        // Unit 41: await the PID-log remove rather than fire-and-forget
        // so /stop's response reflects on-disk reality. Still wrapped
        // in try/catch so a transient I/O error doesn't poison the
        // whole kill chain.
        try {
          await this.pidTracker?.remove(pid);
        } catch {
          // ignore — remove() already swallows errors internally
        }
      }
      this.ports.release(a.port);
      this.lastActivity.delete(a.sessionId);
      this.setAgentState({ id: a.id, index: a.index, port: a.port, sessionId: a.sessionId, status: "stopped" });
    });
    const total = tasks.length;
    await Promise.allSettled(tasks);
    this.agents.clear();
    this.agentStates.clear();
    // Improvement #4: each run gets its own cold-start measurement.
    // killAll fires at run-end, so clearing here means the next run's
    // first prompts emit fresh "cold_start" diag records.
    this.firstPromptLogged.clear();
    // Task #39: drop any residual partial-stream buffers — agent IDs
    // from the killed run no longer exist; the next run spawns fresh.
    this.partialStreams.clear();
    // Task #166: reject + drop any in-flight streamPrompt awaiters so
    // they don't wedge a caller that's blocked waiting for chunks
    // that will never arrive on a killed agent.
    for (const stream of this.streamingByAgent.values()) {
      if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);
      stream.reject(new Error("agent killed"));
    }
    this.streamingByAgent.clear();
    // Task #172: cancel pending throttle flushes — no point emitting
    // streaming text for an agent that's been killed.
    for (const timer of this.streamingFlushTimers.values()) clearTimeout(timer);
    this.streamingFlushTimers.clear();
    this.latestStreamingText.clear();
    // Task #174: drop per-part accumulators for killed agents.
    this.partsByAgent.clear();
    // Task #179: drop message-role classification for killed agents.
    this.messageRoles.clear();
    // Phase 3 of #314: drop usage-capture dedupe set.
    this.capturedUsageMessageIds.clear();
    // 2026-04-27: drop warmup timing cache so the next run doesn't
    // surface a previous run's warmup elapsed in its agents_ready summary.
    this.warmupElapsedByAgent.clear();
    if (escaped > 0) {
      // Unit 41: surface unkillable PIDs to the UI rather than swallowing
      // silently. The next dev-server startup sweep will still reclaim
      // them, but the user deserves to know stop wasn't 100 % clean.
      this.onEvent({
        type: "error",
        message: `stop: ${escaped}/${total} agent process(es) did not exit within the verified-kill window. Startup sweep will reclaim on next restart.`,
      });
    }
    return { total, escaped };
  }

  // Subscribe to the per-agent opencode SSE event stream. Any event from our
  // session counts as "activity" (so the orchestrator's idle watchdog sees
  // work happening). Text part updates get forwarded to the UI as streaming
  // deltas so you can watch an agent type in real time.
  private startEventStream(agent: Agent): void {
    const abort = new AbortController();
    this.eventAborts.set(agent.id, abort);
    this.rawSseCount.set(agent.id, 0);

    // Task #194: SSE auto-reconnect with state reconciliation. The
    // original "subscribe once" pattern made any network blip permanent
    // — agent went SSE-blind for the rest of the run. Now we wrap the
    // subscribe in a backoff loop and on reconnect call session.messages
    // to backfill any chars we missed during the gap. Stops when abort
    // signal fires (run end / agent kill).
    void (async () => {
      const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
      let attempt = 0;
      while (!abort.signal.aborted) {
        const isReconnect = attempt > 0;
        let ended = false;
        try {
          this.logDiag({
            type: isReconnect ? "_sse_reconnecting" : "_sse_subscribed",
            agentId: agent.id,
            sessionId: agent.sessionId,
            attempt,
          });
          // Task #170 (Path B): the SDK's SSE client (createSseClient in
          // gen/core/serverSentEvents.gen.js) uses GLOBAL fetch — it
          // bypasses the authedFetch interceptor we set up at client
          // creation. Without auth, /event returns 401 → SDK retries
          // silently forever → ZERO events delivered. Verified by 0
          // _raw_sse log entries across all logs prior to this fix.
          // Pass the Authorization header explicitly here so the
          // bare-fetch path inside the SDK has it.
          const sub = await agent.client.event.subscribe(
            {},
            {
              signal: abort.signal,
              headers: { Authorization: basicAuthHeader() },
            },
          );
          // Task #194: on reconnect, backfill any text we missed while
          // the SSE channel was down. Same probe path as #192, run once
          // before resuming the for-await so the streamingByAgent state
          // is current before live events resume.
          if (isReconnect) {
            await this.reconcileAfterReconnect(agent).catch((err) => {
              this.logDiag({
                type: "_sse_reconcile_failed",
                agentId: agent.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
          const stream = (sub as { stream: AsyncIterable<unknown> }).stream;
          for await (const ev of stream) {
            if (abort.signal.aborted) break;
            this.logRawSse(agent, ev);
            this.handleSessionEvent(agent, ev);
          }
          ended = true;
          // Reset attempt counter on a clean for-await exit (server
          // closed gracefully — different cause than an error throw).
          attempt = 0;
        } catch (err) {
          if (abort.signal.aborted) break;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${agent.id}] event stream ended (attempt ${attempt}):`, msg);
        }
        if (abort.signal.aborted) break;
        // Pick backoff for the next attempt — capped at 30s.
        const backoffIdx = Math.min(attempt, RECONNECT_BACKOFFS_MS.length - 1);
        const backoff = RECONNECT_BACKOFFS_MS[backoffIdx];
        this.onEvent({
          type: "error",
          message: `SSE stream for ${agent.id} ${ended ? "closed gracefully" : "errored"} — reconnecting in ${Math.round(backoff / 1000)}s`,
        });
        await new Promise<void>((r) => setTimeout(r, backoff));
        attempt += 1;
      }
      // Task #200: final cleanup when the loop exits (abort fired). If
      // any in-flight stream state still exists, mark sseStreamDied so
      // the HTTP catch handler propagates instead of trusting silence.
      if (!abort.signal.aborted) {
        const inflight = this.streamingByAgent.get(agent.id);
        if (inflight) inflight.sseStreamDied = true;
      }
    })();
  }

  // Log raw SSE events pre-filter so we can see if OpenCode is emitting
  // anything at all. Throttled to avoid drowning the JSONL: first 30 events
  // verbatim, then only type+sid summaries. Session-lifecycle events always
  // get through because they're the rarest and most informative.
  private logRawSse(agent: Agent, ev: unknown): void {
    const e = ev as { type?: string; properties?: Record<string, unknown> };
    const type = e?.type;
    const props = (e?.properties ?? {}) as Record<string, unknown>;
    const sid =
      (props.sessionID as string | undefined) ??
      ((props.info as { id?: string; sessionID?: string } | undefined)?.sessionID) ??
      ((props.info as { id?: string } | undefined)?.id) ??
      ((props.part as { sessionID?: string } | undefined)?.sessionID);
    const count = (this.rawSseCount.get(agent.id) ?? 0) + 1;
    this.rawSseCount.set(agent.id, count);
    const isLifecycle = typeof type === "string" && type.startsWith("session.");
    if (count <= 30 || isLifecycle) {
      this.logDiag({
        type: "_raw_sse",
        agentId: agent.id,
        ourSessionId: agent.sessionId,
        eventType: type,
        eventSessionId: sid,
        sidMatches: sid === agent.sessionId,
        count,
      });
    }
  }

  private handleSessionEvent(agent: Agent, ev: unknown): void {
    const e = ev as { type?: string; properties?: Record<string, unknown> };
    const type = e?.type;
    const props = (e?.properties ?? {}) as Record<string, unknown>;

    // Scope to events for this agent's session. Some events carry sessionID
    // directly; message events carry it on info; part events carry it on the part.
    const sid =
      (props.sessionID as string | undefined) ??
      ((props.info as { id?: string; sessionID?: string } | undefined)?.sessionID) ??
      ((props.info as { id?: string } | undefined)?.id) ??
      ((props.part as { sessionID?: string } | undefined)?.sessionID);
    if (sid && sid !== agent.sessionId) return;

    // Every matching event counts as activity; even "message.updated" with no text
    // proves the session is working and the TCP connection is alive.
    this.touchActivity(agent.sessionId);

    // Task #170 (FIX): reset the streamPrompt per-chunk timer on
    // ANY matching SSE event for this agent's session. Earlier
    // "reset on message.* only" version still failed because the
    // long planner-thinking phase emits mostly session.status /
    // session.updated events for tens of seconds before any
    // message.part.delta arrives. Those session.* events DO mean
    // the OpenCode server is alive and processing — exactly the
    // liveness signal we want. The session-id filter above already
    // restricts to our session, so any event reaching this point
    // is proof of life.
    const liveStream = this.streamingByAgent.get(agent.id);
    if (liveStream) {
      liveStream.lastChunkAt = Date.now();
      if (liveStream.timeoutHandle) clearTimeout(liveStream.timeoutHandle);
      liveStream.timeoutHandle = setTimeout(() => {
        this.streamingByAgent.delete(agent.id);
        liveStream.reject(new Error(`per-chunk timeout: no SSE chunks for ${liveStream.perChunkTimeoutMs}ms`));
      }, liveStream.perChunkTimeoutMs);
    }

    // Task #179: track ALL message roles per agent. OpenCode emits
    // message.updated for both user and assistant messages with
    // info.role + info.id. We use this to classify parts that
    // arrive via message.part.updated.
    //
    // Task #182: don't wipe partsByAgent on new assistant message
    // ids. Earlier #179 reset them, but OpenCode emits a NEW
    // assistant message.updated mid-stream at step boundaries (e.g.
    // tool-call → resumed text), which wiped accumulated text from
    // earlier in the same response. Verified via _stream_complete
    // diagnostic: resp 9 of run 2299e75a had latestEmittedChars=6433
    // but partsByAgent=0 — the wipe was the cause. session.idle
    // remains the canonical "prompt boundary" that clears parts;
    // mid-stream id changes are now safe — new parts just append.
    if (type === "message.updated") {
      const info = props.info as
        | {
            id?: string;
            role?: string;
            providerID?: string;
            modelID?: string;
            time?: { completed?: number };
            tokens?: { input?: number; output?: number };
          }
        | undefined;
      if ((info?.role === "user" || info?.role === "assistant") && typeof info.id === "string") {
        let roles = this.messageRoles.get(agent.id);
        if (!roles) {
          roles = new Map();
          this.messageRoles.set(agent.id, roles);
        }
        roles.set(info.id, info.role);
        // 2026-04-27: signal to streamPrompt's session.idle handler that
        // OUR prompt's messages have arrived, so the next session.idle
        // is genuinely ours (not a stale tail from warmup / prior prompt).
        const liveStreamForRoles = this.streamingByAgent.get(agent.id);
        if (liveStreamForRoles && roles.size > liveStreamForRoles.initialRolesSize) {
          liveStreamForRoles.sawNewMessage = true;
        }
      }
      // Phase 3 of #314: capture usage from completed assistant messages
      // for non-Ollama providers. The Ollama proxy already records every
      // /v1/chat/completions roundtrip, so duplicating from session
      // events would double-count. Anthropic/OpenAI go directly via the
      // AI-SDK packages (no proxy in path), so opencode's session events
      // are the only place we see their token counts. Extracted helper
      // returns the UsageRecord shape when applicable, null otherwise.
      if (info && typeof info.id === "string") {
        const usage = extractUsageFromMessageInfo(info);
        if (usage) {
          let captured = this.capturedUsageMessageIds.get(agent.id);
          if (!captured) {
            captured = new Set();
            this.capturedUsageMessageIds.set(agent.id, captured);
          }
          if (!captured.has(info.id)) {
            captured.add(info.id);
            tokenTracker.add(usage);
          }
        }
      }
      return;
    }
    if (type === "message.part.updated") {
      const part = props.part as { type?: string; text?: string; id?: string; messageID?: string } | undefined;
      if (part?.type === "text" && typeof part.text === "string") {
        // Task #179: only accept parts EXPLICITLY classified as
        // assistant. User-role parts AND unknown-role parts both
        // reject. Closes the race where user message.part.updated
        // events arrive before message.updated[role=assistant]
        // sets the messageID — under #175 those leaked through
        // because the filter short-circuited on missing assistantMsgId.
        if (!part.messageID) return;
        const roles = this.messageRoles.get(agent.id);
        const role = roles?.get(part.messageID);
        if (role !== "assistant") return;
        // Task #181: hide warmup pings from UI. The accumulator and
        // role-tracker still update (so session.idle's cleanup runs
        // normally), but UI-facing emits are skipped.
        if (this.suppressStreamingFor.has(agent.id)) return;
        // Task #174: track this text snapshot per-part so a new text
        // part starting at len=0 doesn't wipe earlier parts. Display
        // text = concatenation of all parts in arrival order.
        const partId = part.id ?? "_default";
        let agentParts = this.partsByAgent.get(agent.id);
        if (!agentParts) {
          agentParts = new Map();
          this.partsByAgent.set(agent.id, agentParts);
        }
        agentParts.set(partId, part.text);
        const fullText = [...agentParts.values()].join("\n");
        // Task #39: mirror the FULL stream text (concatenated across
        // parts) into the per-agent buffer for REST catch-up.
        this.partialStreams.set(agent.id, {
          text: fullText,
          updatedAt: Date.now(),
        });
        // Task #172: trailing-edge throttle agent_streaming to ~10/sec
        // so the UI doesn't full-re-render on every 50ms SSE chunk.
        this.scheduleStreamingFlush(agent, fullText);
        // Task #166: feed the streamPrompt accumulator with the FULL
        // text (concatenated across parts) so streamed responses
        // include every text part, not just the last one to update.
        const stream = this.streamingByAgent.get(agent.id);
        if (stream) {
          stream.text = fullText;
          // Task #196: continuous format-violation check. If JSON is
          // expected, look for ANY JSON marker (`{`, `[`, "```json")
          // anywhere in the cumulative text. As soon as one appears
          // we mark the call format-OK and stop checking. If none has
          // appeared by EARLY_FORMAT_SNIFF_BYTES, we conclude the model
          // is producing wrong-format output and abort.
          //
          // Why "anywhere" not "head slice": planner models often emit
          // thinking-mode preamble (chain-of-thought reasoning) before
          // the JSON. Forcing the marker to be in the first 2KB caused
          // false-positives (smoke run f26d7d0f, 2026-04-26 — glm-5.1
          // produced multi-KB reasoning before the JSON, got aborted).
          if (
            stream.formatExpect === "json" &&
            !stream.formatChecked
          ) {
            const looksJson =
              fullText.includes("{") ||
              fullText.includes("[") ||
              fullText.includes("```json");
            if (looksJson) {
              // Marker found — stop checking on subsequent chunks.
              stream.formatChecked = true;
            } else if (fullText.length >= EARLY_FORMAT_SNIFF_BYTES) {
              // Threshold crossed AND still no marker — wrong format.
              this.logDiag({
                type: "_format_sniff_reject",
                agentId: agent.id,
                ourSessionId: agent.sessionId,
                bytesScanned: fullText.length,
                preview: fullText.slice(0, 200),
              });
              this.streamingByAgent.delete(agent.id);
              stream.signalCleanup?.();
              if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);
              stream.reject(new Error(
                `format violation: expected JSON, first ${fullText.length} chars contain no JSON marker`,
              ));
            }
          }
        }
      }
      return;
    }
    if (type === "session.idle") {
      // 2026-04-27: stale-idle filter. session.idle from a prior
      // session.prompt (warmup tail-end OR a previous streamPrompt that
      // already settled) can arrive milliseconds after the next
      // streamPrompt registers state. Without this filter the new
      // prompt's stream resolves with empty text. Detect by checking
      // whether messageRoles has grown since stream registration —
      // opencode emits message.updated for the user + assistant
      // messages our prompt creates BEFORE session.idle. If we haven't
      // seen those, this idle is stale: ignore it. Real session.idle
      // for OUR prompt always arrives AFTER its message.updated events,
      // so sawNewMessage will be true by then.
      const liveStream = this.streamingByAgent.get(agent.id);
      if (liveStream && !liveStream.sawNewMessage && !this.suppressStreamingFor.has(agent.id)) {
        this.logDiag({
          type: "_stale_session_idle_skipped",
          agentId: agent.id,
          ourSessionId: agent.sessionId,
          initialRolesSize: liveStream.initialRolesSize,
          currentRolesSize: this.messageRoles.get(agent.id)?.size ?? 0,
          ts: Date.now(),
        });
        return;
      }
      // Task #181: skip both the diagnostic and the agent_streaming_end
      // emit when this agent is in warmup-suppression mode. The
      // _stream_complete log isn't useful for warmup pings, and we
      // never emitted any agent_streaming so there's nothing to "end"
      // on the UI side.
      if (this.suppressStreamingFor.has(agent.id)) {
        this.partialStreams.delete(agent.id);
        this.partsByAgent.delete(agent.id);
        this.messageRoles.delete(agent.id);
        this.capturedUsageMessageIds.delete(agent.id);
        const stream = this.streamingByAgent.get(agent.id);
        if (stream) {
          this.streamingByAgent.delete(agent.id);
          stream.resolve(stream.text);
        }
        return;
      }
      // Task #180: diagnostic log of what we accumulated for display.
      // Lets us verify that ALL assistant text parts received via SSE
      // make it to the UI — comparing this to the eventual transcript
      // entry's text length surfaces any drops (race conditions,
      // throttle gaps, role-filter false-negatives, segment-splitter
      // bugs). Logged BEFORE we drop the per-agent state so we
      // can introspect the final accumulator contents.
      const finalParts = this.partsByAgent.get(agent.id);
      const finalText = this.latestStreamingText.get(agent.id) ?? "";
      const partSummary = finalParts
        ? Array.from(finalParts.entries()).map(([pid, t]) => ({
            partId: pid.slice(0, 12),
            chars: t.length,
          }))
        : [];
      const totalCharsAccumulated = partSummary.reduce((s, p) => s + p.chars, 0);
      const roles = this.messageRoles.get(agent.id);
      const assistantMsgIds = roles
        ? Array.from(roles.entries()).filter(([, r]) => r === "assistant").map(([id]) => id.slice(0, 12))
        : [];
      const userMsgIds = roles
        ? Array.from(roles.entries()).filter(([, r]) => r === "user").map(([id]) => id.slice(0, 12))
        : [];
      this.logDiag({
        type: "_stream_complete",
        agentId: agent.id,
        partsCount: partSummary.length,
        partsBreakdown: partSummary,
        totalCharsAccumulated,
        // The flushed text is what the UI saw last. The +concatenation
        // of parts is what we emit. They should match (modulo a join
        // separator of "\n" between parts).
        latestEmittedChars: finalText.length,
        assistantMsgIds,
        userMsgIds,
        partialStreamChars: this.partialStreams.get(agent.id)?.text.length ?? 0,
        ts: Date.now(),
      });
      // Task #39: stream finalized, drop the partial buffer.
      this.partialStreams.delete(agent.id);
      // Task #174: drop the per-part accumulator so the next prompt
      // on this agent starts with a fresh slate.
      this.partsByAgent.delete(agent.id);
      // Task #179: clear message-role tracking for this agent. Next
      // prompt's first message.updated starts fresh classification.
      this.messageRoles.delete(agent.id);
      // Phase 3 of #314: drop usage-capture dedupe set on session.idle.
      this.capturedUsageMessageIds.delete(agent.id);
      // Task #172: flush any pending throttled streaming text so the
      // UI lands on the FINAL state before we tell it the stream
      // ended. Without this, the trailing-edge throttle could leave
      // the last 100ms of text un-emitted, causing a tiny flash
      // back to a slightly-older snapshot at end-of-stream.
      this.flushStreamingNow(agent);
      this.onEvent({ type: "agent_streaming_end", agentId: agent.id });
      // Task #166: settle the streamPrompt awaiter for this agent.
      const stream = this.streamingByAgent.get(agent.id);
      if (stream) {
        this.streamingByAgent.delete(agent.id);
        stream.resolve(stream.text);
      }
      return;
    }
  }

  // Task #172: throttled streaming-text dispatch. Agent text snapshots
  // arrive every ~50ms during model output; we coalesce to one emit
  // per STREAMING_THROTTLE_MS (100ms = 10 Hz). Trailing-edge timer:
  // first chunk schedules a flush, subsequent chunks just update the
  // latest text, the timer fires once and emits the latest snapshot.
  // 2026-04-27 (UI Phase 2): dropped 100 → 33 (30Hz). At 100ms (10Hz)
  // the throttle was visibly choppy when chunks arrived rapidly — and
  // when chunks arrived in BIG batches (V2 OllamaClient direct path),
  // the throttle would deliver a single big update with nothing
  // visually in between. 33ms (~30Hz) lets the UI feel smooth without
  // overwhelming the WS channel — same cadence modern chat UIs use.
  private static readonly STREAMING_THROTTLE_MS = 33;

  // V2 Step 1: public hook for the Ollama-direct path (promptWithRetry).
  // Bypasses the SSE/streamPrompt machinery entirely — caller already
  // has the cumulative text from the chunked-HTTP read and just needs
  // to mirror it into the existing per-agent buffers + trigger a UI
  // emit (throttled, same as the SSE path).
  recordStreamingText(agentId: string, agentIndex: number, cumulativeText: string): void {
    this.partialStreams.set(agentId, { text: cumulativeText, updatedAt: Date.now() });
    // Use the same throttled flush as the SSE path so the UI gets
    // ~10Hz updates.
    this.scheduleStreamingFlush({ id: agentId, index: agentIndex } as Agent, cumulativeText);
  }

  // V2 Step 1: emit the streaming-end event for the Ollama-direct path
  // so the PersistentStreamBubble flips to "done ✓" the same way it
  // does for the SSE path's session.idle.
  markStreamingDone(agentId: string): void {
    this.onEvent({ type: "agent_streaming_end", agentId });
    // Drop per-agent partial-stream buffer — the response is final.
    this.partialStreams.delete(agentId);
    const flushTimer = this.streamingFlushTimers.get(agentId);
    if (flushTimer) clearTimeout(flushTimer);
    this.streamingFlushTimers.delete(agentId);
    this.latestStreamingText.delete(agentId);
  }

  private scheduleStreamingFlush(agent: Agent, text: string): void {
    this.latestStreamingText.set(agent.id, text);
    if (this.streamingFlushTimers.has(agent.id)) return;
    this.streamingFlushTimers.set(
      agent.id,
      setTimeout(() => {
        this.streamingFlushTimers.delete(agent.id);
        const latest = this.latestStreamingText.get(agent.id);
        if (latest === undefined) return;
        this.onEvent({
          type: "agent_streaming",
          agentId: agent.id,
          agentIndex: agent.index,
          text: latest,
        });
      }, AgentManager.STREAMING_THROTTLE_MS),
    );
  }

  private flushStreamingNow(agent: Agent): void {
    const timer = this.streamingFlushTimers.get(agent.id);
    if (timer) {
      clearTimeout(timer);
      this.streamingFlushTimers.delete(agent.id);
    }
    const latest = this.latestStreamingText.get(agent.id);
    this.latestStreamingText.delete(agent.id);
    if (latest === undefined) return;
    this.onEvent({
      type: "agent_streaming",
      agentId: agent.id,
      agentIndex: agent.index,
      text: latest,
    });
  }

  // Task #39: expose the current per-agent partial-stream buffer as a
  // plain object snapshot so callers (runner status() paths) can
  // include it in the SwarmStatus returned by REST catch-up. Returns
  // a defensive copy — callers can't mutate our internal map.
  getPartialStreams(): Record<string, { text: string; updatedAt: number }> {
    const out: Record<string, { text: string; updatedAt: number }> = {};
    for (const [agentId, s] of this.partialStreams.entries()) {
      out[agentId] = { text: s.text, updatedAt: s.updatedAt };
    }
    return out;
  }

  // Task #41: retry session.create once on transient failures (the
  // parallel-spawn race observed during UI testing 2026-04-24).
  // Logs a diag record on each attempt so if the race still fires
  // after this change we get concrete data on what's throwing. The
  // retry waits a jittered 100-250ms — short enough to not slow
  // successful spawns visibly, long enough to let the sibling agents'
  // session.create calls clear their queue.
  private async createSessionWithRetry(client: Client, agentId: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await client.session.create({ title: agentId });
      } catch (err) {
        lastErr = err;
        this.logDiag({
          type: "_session_create_failed",
          agentId,
          attempt,
          error: stringifyError(err),
        });
        if (attempt >= 2) break;
        // Jittered backoff: 100-250ms. Avoids retrying all N siblings
        // at the same post-failure moment which would just reproduce
        // the race.
        const delay = 100 + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  private async waitForReady(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/doc`;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await authedFetch(url);
        if (res.ok) return;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`opencode server on :${port} never became ready: ${String(lastErr)}`);
  }

  private readSessionId(res: unknown): string | undefined {
    // The SDK returns { data, error } shaped responses; the session object carries an `id`.
    const any = res as { data?: { id?: string; info?: { id?: string } }; id?: string };
    return any?.data?.id ?? any?.data?.info?.id ?? any?.id;
  }
}

// Robust error-to-string that handles non-Error throwables (plain
// objects like { data: {...} } that the OpenCode SDK can throw when
// throwOnError=true). Falls back through: Error.message → .name +
// .message → JSON.stringify → String. Without this, concurrent-spawn
// races surface in the UI as "[object Object]" — useless for
// debugging.
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string; code?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(err).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}

// Task #192: pull the latest ASSISTANT message's concatenated text-part
// content from a session.messages response. Used by probeAndDecide to
// check whether the model is still producing tokens when SSE goes quiet.
// Returns null if no assistant message exists yet (early in the call).
function extractLatestAssistantText(res: unknown): string | null {
  // Shape: { data: Array<{ info: Message, parts: Part[] }> } per SDK gen
  // — but the SDK wrapper sometimes returns the array directly. Handle both.
  const wrapper = res as { data?: unknown };
  const list = (wrapper?.data ?? res) as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>;
  if (!Array.isArray(list)) return null;
  // Find LAST assistant message (most recent).
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg?.info?.role !== "assistant") continue;
    const parts = msg.parts ?? [];
    let combined = "";
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") combined += p.text;
    }
    return combined;
  }
  return null;
}
