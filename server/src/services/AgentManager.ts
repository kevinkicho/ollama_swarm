// E3 Phase 5 cleanup pt 5 (2026-04-29): @opencode-ai/sdk + the
// `Client` / `SessionClient` stub types REMOVED. Agent no longer
// carries a `client` field; every prompt routes through pickProvider
// and every spawn through spawnAgent (no real subprocess).
import type { ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { treeKill } from "./treeKill.js";
import { AgentPidTracker } from "./agentPids.js";
import type { AgentState, SwarmEvent } from "../types.js";
import { tokenTracker } from "./ollamaProxy.js";
import { createSession, type Session } from "./Session.js";
import { escalateProcessKill } from "./agentKill.js";
import { StreamingTextThrottle } from "./agentStreaming.js";


// Unit 17: minimal-token warmup prompt sent to each new agent right
// after spawn. Intentionally trivial — we don't care about the response
// content, only about loading model state on the cloud shard so the
// runner's first real prompt doesn't pay cold-start latency.
export const WARMUP_PROMPT_TEXT = "Reply with one word: ok";

// Usage extraction lives in agentUsage.ts; re-export for existing imports.
export {
  extractUsageFromMessageInfo,
  type ExtractedUsage,
} from "./agentUsage.js";

export interface Agent {
  id: string;
  index: number;
  sessionId: string;
  /** Post-E3: port was removed from the formal type but many callers still
   *  reference it at runtime (was always 0). Kept optional for backward compat. */
  port?: number;
  /** Always undefined post-E3 (no opencode subprocess). Field kept for
   *  callers that still type-narrow with `agent.child?.pid`. */
  child?: ChildProcess;
  model: string;
  /** Clone path the agent operates on. Used by ToolDispatcher to scope
   *  read/grep/glob/list/bash to this agent's working tree. */
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

export class AgentManager {
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
  /** In-flight prompt session ids — binds markStatus to agent_activity. */
  private readonly promptActivityByAgent = new Map<
    string,
    { activityId: string; kind?: string; label?: string }
  >();
  /**
   * Last agent_activity record per agent — included in REST /status so
   * reconnect/hydrate restores sidebar labels and phase (not WS-only).
   */
  /** Ring buffer of activity transitions per agent (B6 timeline product). */
  private readonly activityHistoryByAgent = new Map<
    string,
    Array<{
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      kind?: string;
      label?: string;
      activityId?: string;
    }>
  >();
  private static readonly ACTIVITY_HISTORY_LIMIT = 40;

  private readonly lastActivityByAgent = new Map<
    string,
    {
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      startedAt: number;
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
    }
  >();
  // Kill guard: once killAll() completes, any stale setAgentState calls
  // that race with the clear (e.g., a prompt catch-block running on a
  // microtask after the kill) are silently dropped instead of re-adding
  // an already-dead agent to the map. Reset by spawnAgent / spawnAgent.
  private killed = false;
  /** Provider-session abort handles — fired on killAll to cancel in-flight HTTP. */
  private readonly sessions = new Map<string, Session>();
  // Unit 38: persistent PID tracking for orphan reclamation across
  // dev-server restarts. When present, AgentManager appends a record
  // per successful spawn and removes it on clean exit / killAll. When
  // absent (older callers / tests), PID tracking is a no-op — the
  // manager still works, orphans just don't get reclaimed.
  private readonly pidTracker?: AgentPidTracker;
  private readonly streamingThrottle: StreamingTextThrottle;
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
    this.streamingThrottle = new StreamingTextThrottle({
      shouldSuppress: (id) =>
        this.runStreamingSuppressed || this.suppressStreamingFor.has(id),
      onStreaming: (p) =>
        this.onEvent({
          type: "agent_streaming",
          agentId: p.agentId,
          agentIndex: p.agentIndex,
          text: p.text,
        }),
      onStreamingEnd: (agentId) =>
        this.onEvent({ type: "agent_streaming_end", agentId }),
    });
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

  // Task #192: when the per-chunk SSE timer fires, probe the session
  // via REST before declaring death. If the latest assistant message
  // has grown beyond what we've seen via SSE, the SSE delivery channel
  // is broken — backfill the missed text, reset the per-chunk timer,
  // and keep waiting. Only reject if the model is genuinely silent.
  //
  // This decouples "SSE channel health" from "model health" — they're
  // two independent failure modes that previously both presented as
  // "no chunks in 90s = abort".

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
    if (this.killed) return;
    if (this.runShutdownStarted && (s.status === "thinking" || s.status === "retrying")) return;
    this.agentStates.set(s.id, s);
    this.onState(s);
  }

  /**
   * Immediate run shutdown: stop streaming to the UI and abort in-flight provider
   * HTTP before killAll() tears down processes. Idempotent — safe to call from
   * stop() and again from close-out.
   */
  beginRunShutdown(): void {
    if (this.runShutdownStarted) return;
    this.runShutdownStarted = true;
    this.runStreamingSuppressed = true;

    for (const a of this.agents.values()) {
      const stopped: AgentState = {
        id: a.id,
        index: a.index,
        sessionId: a.sessionId,
        model: a.model,
        status: "stopped",
      };
      this.agentStates.set(a.id, stopped);
      this.onState(stopped);
      this.endStreamingUi(a.id);
      const priorAct = this.lastActivityByAgent.get(a.id);
      if (priorAct && priorAct.phase !== "done") {
        this.emitAgentActivity(a.id, a.index, "done", { activityId: priorAct.activityId });
      }
      this.promptActivityByAgent.delete(a.id);
    }

    for (const session of this.sessions.values()) {
      try {
        session.abortController.abort(new Error("run shutdown"));
      } catch {
        // best-effort
      }
    }

    for (const stream of this.streamingByAgent.values()) {
      if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);
      stream.reject(new Error("run shutdown"));
    }
    this.streamingByAgent.clear();

    this.streamingThrottle.clearAll();
    this.partsByAgent.clear();
    this.messageRoles.clear();
  }

  private endStreamingUi(agentId: string): void {
    this.streamingThrottle.markDone(agentId);
  }

  // Register an agent session (no subprocess). E3 removed per-agent
  // opencode processes; killAll handles agent.child=undefined.
  async spawnAgent(opts: SpawnOpts): Promise<Agent> {
    const id = `agent-${opts.index}`;
    const session = createSession(opts.model);
    const stateBase: AgentState = {
      id,
      index: opts.index,
      status: "ready",
      sessionId: session.id,
      model: opts.model,
    };
    this.killed = false;
    this.runShutdownStarted = false;
    this.runStreamingSuppressed = false;
    this.sessions.set(session.id, session);
    this.setAgentState(stateBase);
    const agent: Agent = {
      id,
      index: opts.index,
      sessionId: session.id,
      child: undefined,
      model: opts.model,
      cwd: opts.cwd,
    };
    this.agents.set(id, agent);
    return agent;
  }

  // Unit 18: warm a batch of agents one at a time. Used by runners
  // that pass skipWarmup:true to spawnAgent and then warm explicitly
  // after the parallel spawn batch returns. Serial warmup loads cloud
  // shards one-by-one, working around the cloud load balancer's
  // apparent inability to load N shards in parallel for the same
  // client (battle test v3 showed parallel warmups didn't help
  // map-reduce, council, OW — same outcome as no warmup at all).

  // Unit 18: warm a batch of agents in parallel. Used by parallel-fan-out
  // runners (council/OW/map-reduce) immediately before each runner's
  // FIRST parallel real-turn batch. The cloud handles N parallel small
  // prompts (warmup) better than N parallel large prompts (real turns
  // with full transcript), so paying the parallel cold-start cost on
  // small prompts spares the real batch from the same penalty.

  // Unit 17: send a trivial prompt to the agent right after spawn so
  // the cloud shard loads model state BEFORE the runner asks for real
  // work. Cuts the cold-start tail that bumping headersTimeout 90→180s
  // (Unit 16) couldn't fully cover. Non-fatal — if warmup itself fails
  // (headers timeout, network blip) we log it and proceed; the next
  // real prompt has at minimum told the cloud shard we exist.
  // Unit 18: made public so runners can call it explicitly via
  // warmupSerially / warmupParallel after a parallel spawn batch.

  /** Unified prompt-session lifecycle signal (control plane). Data-plane
   *  tokens still flow via agent_streaming; this binds status + dock slots. */
  emitAgentActivity(
    agentId: string,
    agentIndex: number,
    phase: "queued" | "waiting" | "streaming" | "retrying" | "done",
    extra: {
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
    } = {},
  ): void {
    // Suppress media noise during warmup — but never drop terminal "done"
    // (and allow retrying) so the sidebar can demote after a real prompt.
    if (this.suppressStreamingFor.has(agentId) && phase !== "done" && phase !== "retrying") {
      return;
    }
    const ts = Date.now();
    const prior = this.lastActivityByAgent.get(agentId);
    const freshSession =
      (phase === "queued" || phase === "waiting")
      && (!prior || prior.phase === "done" || prior.activityId !== extra.activityId);
    const startedAt = freshSession ? ts : (prior?.startedAt ?? ts);
    const record = {
      phase,
      ts,
      startedAt,
      activityId: extra.activityId ?? prior?.activityId,
      kind: extra.kind ?? prior?.kind,
      label: extra.label ?? prior?.label,
      attempt: extra.attempt ?? prior?.attempt,
      maxAttempts: extra.maxAttempts ?? prior?.maxAttempts,
      reason:
        phase === "done"
          ? undefined
          : extra.reason !== undefined
            ? extra.reason
            : prior?.reason,
    };
    this.lastActivityByAgent.set(agentId, record);
    // Append to per-agent ring buffer for hydrate timeline (not only last phase).
    let hist = this.activityHistoryByAgent.get(agentId);
    if (!hist) {
      hist = [];
      this.activityHistoryByAgent.set(agentId, hist);
    }
    hist.push({
      phase,
      ts,
      kind: record.kind,
      label: record.label,
      activityId: record.activityId,
    });
    if (hist.length > AgentManager.ACTIVITY_HISTORY_LIMIT) {
      hist.splice(0, hist.length - AgentManager.ACTIVITY_HISTORY_LIMIT);
    }
    this.onEvent({
      type: "agent_activity",
      agentId,
      agentIndex,
      phase,
      ts,
      ...extra,
    });
  }

  getPromptActivity(agentId: string): { activityId: string; kind?: string; label?: string } | undefined {
    return this.promptActivityByAgent.get(agentId);
  }

  /** Current mirror state for an agent (prompt layer / status ownership). */
  getState(agentId: string): AgentState | undefined {
    return this.agentStates.get(agentId);
  }

  /** Snapshot of last activity per agent for REST /status hydrate. */
  getActivitySnapshot(): Record<
    string,
    {
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      startedAt: number;
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
      /** Recent activity transitions (newest last), for sidebar timeline. */
      history?: Array<{
        phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
        ts: number;
        kind?: string;
        label?: string;
        activityId?: string;
      }>;
    }
  > {
    const out: Record<string, {
      phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
      ts: number;
      startedAt: number;
      activityId?: string;
      kind?: string;
      label?: string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
      history?: Array<{
        phase: "queued" | "waiting" | "streaming" | "retrying" | "done";
        ts: number;
        kind?: string;
        label?: string;
        activityId?: string;
      }>;
    }> = {};
    for (const [id, rec] of this.lastActivityByAgent) {
      const history = this.activityHistoryByAgent.get(id);
      out[id] = {
        ...rec,
        ...(history && history.length > 0 ? { history: [...history] } : {}),
      };
    }
    return out;
  }

  /** Full activity timeline across agents (capped), for status hydrate. */
  getActivityTimeline(limit = 80): Array<{
    agentId: string;
    phase: string;
    ts: number;
    kind?: string;
    label?: string;
    activityId?: string;
  }> {
    const all: Array<{
      agentId: string;
      phase: string;
      ts: number;
      kind?: string;
      label?: string;
      activityId?: string;
    }> = [];
    for (const [agentId, hist] of this.activityHistoryByAgent) {
      for (const h of hist) {
        all.push({ agentId, ...h });
      }
    }
    all.sort((a, b) => a.ts - b.ts);
    return all.slice(-limit);
  }

  /** Resolve label/kind for promptWithRetry — prefers runner markStatus, then opts. */
  resolvePromptActivity(
    agentId: string,
    agentIndex: number,
    fromOpts?: { kind?: string; label?: string; activityId?: string },
  ): { activityId: string; kind?: string; label?: string; emitQueued: boolean } {
    const mirror = this.agentStates.get(agentId);
    const existing = this.promptActivityByAgent.get(agentId);
    if (existing && mirror?.status === "thinking") {
      return {
        activityId: existing.activityId,
        kind: fromOpts?.kind ?? existing.kind ?? mirror.activityKind,
        label: fromOpts?.label ?? existing.label ?? mirror.activityLabel,
        emitQueued: false,
      };
    }
    const activityId = fromOpts?.activityId ?? `${agentId}-${Date.now()}`;
    const kind = fromOpts?.kind ?? mirror?.activityKind;
    const label = fromOpts?.label ?? mirror?.activityLabel;
    this.promptActivityByAgent.set(agentId, { activityId, kind, label });
    return { activityId, kind, label, emitQueued: true };
  }

  clearPromptActivity(agentId: string): void {
    this.promptActivityByAgent.delete(agentId);
  }

  /** New prompt attempt after retry — emits queued with fresh activityId. */
  renewPromptActivity(agentId: string, agentIndex: number, attempt: number): string {
    const prior = this.promptActivityByAgent.get(agentId);
    const activityId = `${agentId}-${Date.now()}`;
    const next = { activityId, kind: prior?.kind, label: prior?.label };
    this.promptActivityByAgent.set(agentId, next);
    this.emitAgentActivity(agentId, agentIndex, "waiting", {
      activityId,
      kind: next.kind,
      label: next.label,
      attempt,
      maxAttempts: 3,
    });
    return activityId;
  }

  markStatus(id: string, status: AgentState["status"], extra: Partial<AgentState> = {}): void {
    const a = this.agents.get(id);
    if (!a) return;
    if (this.runShutdownStarted && (status === "thinking" || status === "retrying")) return;
    const patch: Partial<AgentState> = { ...extra };
    // Unit 39: callers often markStatus("thinking") without thinkingSince.
    // Auto-fill so REST /status + sidebar elapsed ticker stay in sync.
    if (status === "thinking" && patch.thinkingSince === undefined) {
      patch.thinkingSince = Date.now();
    }
    if (status === "thinking") {
      const prior = this.promptActivityByAgent.get(id);
      const activityId = prior?.activityId ?? `${id}-${patch.thinkingSince ?? Date.now()}`;
      const kind = patch.activityKind ?? prior?.kind;
      const label = patch.activityLabel ?? prior?.label;
      this.promptActivityByAgent.set(id, {
        activityId,
        kind,
        label,
      });
      this.emitAgentActivity(id, a.index, "waiting", {
        activityId,
        kind,
        label,
        attempt: patch.activityAttempt,
        maxAttempts: patch.activityMaxAttempts,
      });
    } else if (status === "retrying") {
      const pa = this.promptActivityByAgent.get(id);
      this.emitAgentActivity(id, a.index, "retrying", {
        activityId: pa?.activityId,
        kind: patch.activityKind ?? pa?.kind,
        label: patch.activityLabel ?? pa?.label,
        attempt: patch.retryAttempt,
        maxAttempts: patch.retryMax,
        reason: patch.retryReason,
      });
    } else {
      const pa = this.promptActivityByAgent.get(id);
      if (pa) {
        this.emitAgentActivity(id, a.index, "done", { activityId: pa.activityId });
        this.promptActivityByAgent.delete(id);
      }
      patch.thinkingSince = undefined;
      patch.activityKind = undefined;
      patch.activityLabel = undefined;
      patch.activityAttempt = undefined;
      patch.activityMaxAttempts = undefined;
    }
    this.setAgentState({ id, index: a.index, sessionId: a.sessionId, model: a.model, status, ...patch });
  }

  updateAgentModel(id: string, model: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.model = model;
    const existing = this.agentStates.get(id);
    if (existing) {
      this.setAgentState({ ...existing, model });
    }
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
    // Merge with existing mirror so partial runner emits (status-only)
    // cannot wipe activityLabel / thinkingSince / model set by markStatus.
    const existing = this.agentStates.get(s.id);
    const agent = this.agents.get(s.id);
    const busy =
      s.status === "thinking" || s.status === "retrying";
    const merged: AgentState = {
      ...existing,
      ...s,
      id: s.id,
      index: s.index ?? existing?.index ?? agent?.index ?? 0,
      model: s.model ?? existing?.model ?? agent?.model,
      sessionId: s.sessionId ?? existing?.sessionId ?? agent?.sessionId,
      thinkingSince:
        busy
          ? (s.thinkingSince ?? existing?.thinkingSince)
          : undefined,
      activityKind:
        busy
          ? (s.activityKind ?? existing?.activityKind)
          : s.activityKind,
      activityLabel:
        busy
          ? (s.activityLabel ?? existing?.activityLabel)
          : s.activityLabel,
      activityAttempt:
        busy
          ? (s.activityAttempt ?? existing?.activityAttempt)
          : s.activityAttempt,
      activityMaxAttempts:
        busy
          ? (s.activityMaxAttempts ?? existing?.activityMaxAttempts)
          : s.activityMaxAttempts,
    };
    if (!busy) {
      merged.thinkingSince = undefined;
      if (s.status === "ready" || s.status === "stopped" || s.status === "failed") {
        merged.activityKind = undefined;
        merged.activityLabel = undefined;
        merged.activityAttempt = undefined;
        merged.activityMaxAttempts = undefined;
      }
    }
    this.setAgentState(merged);
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
  /** True from beginRunShutdown() until the next spawn — blocks streaming/UI churn during close-out. */
  private runShutdownStarted = false;
  private runStreamingSuppressed = false;

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
      port: agent?.port ?? 0,
      model: agent?.model,
      attempt: info.attempt,
      elapsedMs: info.elapsedMs,
      success: info.success,
      ts: Date.now(),
    });
  }

  // T-Item-4 (2026-05-04): is the named agent currently mid-prompt?
  // Returns true when the agent's mirrored status is "thinking" or
  // "retrying". Used by the adaptive worker pool's scale-down logic
  // to refuse to kill a worker that's actively working on a todo —
  // killing mid-prompt would orphan the in-flight commit attempt.
  isInFlight(id: string): boolean {
    const s = this.agentStates.get(id);
    if (!s) return false;
    return s.status === "thinking" || s.status === "retrying";
  }

  // T-Item-4 (2026-05-04): kill ONE agent mid-run (vs whole-run kill).
  // Used by the adaptive worker pool when scaling down. Steps:
  //  1. Find agent (no-op if unknown id)
  //  2. Abort any in-flight SSE event subscription
  //  3. tree-kill the child process
  //  4. Remove from agents map + agentStates mirror
  //  5. Emit agent_state with status="killed" so the UI removes the panel
  //  6. Cleanup pidTracker entry
  // The graceful "wait for in-flight to settle" is the caller's
  // responsibility — they should check isInFlight() first and skip if
  // they want to wait for an idle worker. We hard-kill on demand here
  // so the watchdog can stay simple (no async wait-loop).
  async killAgent(id: string): Promise<void> {
    const a = this.agents.get(id);
    if (!a) return;
    // Abort the SSE event subscription. Mirrors what killAll does.
    const ctrl = this.eventAborts.get(id);
    if (ctrl) {
      ctrl.abort();
      this.eventAborts.delete(id);
    }
    // Tree-kill the child process. Best-effort — same as killAll's
    // first stage. We don't wait for confirmation here (the watchdog's
    // poll interval will catch a stuck PID via the next cycle).
    treeKill(a.child);
    const pid = a.child?.pid;
    if (pid !== undefined) {
      try {
        await this.pidTracker?.remove(pid);
      } catch {
        // ignore — remove() already swallows internally
      }
    }
    // Remove from internal state
    this.agents.delete(id);
    this.agentStates.delete(id);
    this.lastActivity.delete(a.sessionId);
    this.streamingThrottle.clearAgent(id);
    this.firstPromptLogged.delete(id);
    this.warmupElapsedByAgent.delete(id);
    // Emit removal so the UI store drops the panel
    this.setAgentState({
      id: a.id,
      index: a.index,
      sessionId: a.sessionId,
      model: a.model,
      status: "killed",
    });
  }

  async killAll(): Promise<KillAllResult> {
    this.beginRunShutdown();
    // Broadcast "stopped" state for each agent BEFORE setting killed=true.
    // The killed guard in setAgentState discards events after killed is set,
    // so these intentional "stopped" transitions must fire first for the
    // UI to update agent cards to "stopped" before they're cleared.
    for (const a of this.agents.values()) {
      this.agentStates.set(a.id, { id: a.id, index: a.index, sessionId: a.sessionId, model: a.model, status: "stopped" });
      this.onState({ id: a.id, index: a.index, sessionId: a.sessionId, model: a.model, status: "stopped" });
    }
    for (const session of this.sessions.values()) {
      try {
        session.abortController.abort(new Error("agent killed"));
      } catch {
        // best-effort
      }
    }
    this.sessions.clear();
    this.killed = true;
    for (const ctrl of this.eventAborts.values()) ctrl.abort();
    this.eventAborts.clear();
    let escaped = 0;
    const tasks = [...this.agents.values()].map(async (a) => {
      // Unit 41 + Task #122: multi-stage kill (treeKill → killByPid → killByPort).
      const result = await escalateProcessKill({ child: a.child, port: a.port });
      if (result.escaped) escaped += 1;
      const pid = a.child?.pid;
      if (pid !== undefined) {
        try {
          await this.pidTracker?.remove(pid);
        } catch {
          // ignore
        }
      }
      this.lastActivity.delete(a.sessionId);
    });
    const total = tasks.length;
    await Promise.allSettled(tasks);
    this.agents.clear();
    this.agentStates.clear();
    this.firstPromptLogged.clear();
    this.promptActivityByAgent.clear();
    this.lastActivityByAgent.clear();
    this.activityHistoryByAgent.clear();
    this.streamingThrottle.clearAll();
    for (const stream of this.streamingByAgent.values()) {
      if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);
      stream.reject(new Error("agent killed"));
    }
    this.streamingByAgent.clear();
    this.partsByAgent.clear();
    this.messageRoles.clear();
    this.capturedUsageMessageIds.clear();
    this.warmupElapsedByAgent.clear();
    // Authoritative empty roster — client must drop ghost cards from prior
    // phases (pipeline handoff) or post-kill leftover stopped rows.
    this.onEvent({ type: "agents_roster", agents: [] });
    if (escaped > 0) {
      this.onEvent({
        type: "error",
        message: `stop: ${escaped}/${total} agent process(es) did not exit within the verified-kill window. Startup sweep will reclaim on next restart.`,
      });
    }
    return { total, escaped };
  }

  // V2 Step 1: public hook for the Ollama-direct path (promptWithRetry).
  recordStreamingText(agentId: string, agentIndex: number, cumulativeText: string): void {
    if (this.runStreamingSuppressed) return;
    this.streamingThrottle.record(agentId, agentIndex, cumulativeText);
  }

  markStreamingDone(agentId: string, opts?: { preservePartial?: boolean }): void {
    this.streamingThrottle.markDone(agentId, opts);
  }

  // Task #39: expose the current per-agent partial-stream buffer as a
  // plain object snapshot so callers (runner status() paths) can
  // include it in the SwarmStatus returned by REST catch-up. Returns
  // a defensive copy — callers can't mutate our internal map.
  getPartialStreams(): Record<string, { text: string; updatedAt: number }> {
    const out: Record<string, { text: string; updatedAt: number }> = {};
    for (const [agentId, s] of this.streamingThrottle.getAllPartials().entries()) {
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
  // E3 Phase 5 cleanup pt 3: createSessionWithRetry / waitForReady /
  // readSessionId DELETED. They were only called from spawnAgent's old
  // body which is gone — zero remaining callers.
}

// Text helpers live in agentTextUtils.ts (available for prompt/probe paths).
export { stringifyError, extractLatestAssistantText } from "./agentTextUtils.js";
