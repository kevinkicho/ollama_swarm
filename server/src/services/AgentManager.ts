import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config, basicAuthHeader } from "../config.js";
import { PortAllocator } from "./PortAllocator.js";
import { treeKill, killByPid, isProcessAlive } from "./treeKill.js";
import { AgentPidTracker } from "./agentPids.js";
import type { AgentState, SwarmEvent } from "../types.js";

type Client = ReturnType<typeof createOpencodeClient>;

// Unit 17: minimal-token warmup prompt sent to each new agent right
// after spawn. Intentionally trivial — we don't care about the response
// content, only about loading model state on the cloud shard so the
// runner's first real prompt doesn't pay cold-start latency.
export const WARMUP_PROMPT_TEXT = "Reply with one word: ok";

export interface Agent {
  id: string;
  index: number;
  port: number;
  sessionId: string;
  client: Client;
  child?: ChildProcess;
  model: string;
}

// Unit 41: killAll now reports whether every process was confirmed
// dead before it returned. Callers that want to surface this (e.g.
// POST /stop response) can read `escaped > 0` and warn; the older
// fire-and-forget callers can ignore it and behave exactly as before.
export interface KillAllResult {
  total: number;
  escaped: number;
}

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
  private orchestratorClient?: Client;
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

  getOrchestratorClient(): Client {
    if (!this.orchestratorClient) {
      this.orchestratorClient = createOpencodeClient({
        baseUrl: config.OPENCODE_BASE_URL,
        fetch: authedFetch,
        throwOnError: true,
      });
    }
    return this.orchestratorClient;
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.index - b.index);
  }

  toStates(): AgentState[] {
    // Unit 21: returns actual current state per agent (may be
    // "thinking" / "retrying" / "failed" / "stopped"), not the
    // hardcoded "ready" we returned pre-Unit-21. Sorted by index for
    // deterministic UI ordering.
    return [...this.agentStates.values()].sort((a, b) => a.index - b.index);
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

  async spawnAgent(opts: SpawnOpts): Promise<Agent> {
    const port = await this.ports.allocate();
    const id = `agent-${opts.index}`;
    const stateBase: AgentState = { id, index: opts.index, port, status: "spawning" };
    this.setAgentState(stateBase);

    let child: ChildProcess | undefined;
    try {
      const spawnEnv = {
        ...process.env,
        OPENCODE_SERVER_USERNAME: config.OPENCODE_SERVER_USERNAME,
        OPENCODE_SERVER_PASSWORD: config.OPENCODE_SERVER_PASSWORD,
      };
      const spawnOpts: import("node:child_process").SpawnOptions = {
        cwd: opts.cwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };
      if (process.platform === "win32") {
        // On Windows opencode is installed as a .cmd wrapper that spawn() can't find
        // without shell. Use a single command string (not args-array) so we don't
        // trigger DEP0190. Port/bin come from our own allocator/config, not user input.
        child = spawn(
          `${config.OPENCODE_BIN} serve --port ${port} --hostname 127.0.0.1`,
          { ...spawnOpts, shell: true },
        );
      } else {
        child = spawn(
          config.OPENCODE_BIN,
          ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
          spawnOpts,
        );
      }

      const teeLine = (stream: "stdout" | "stderr") => (buf: Buffer | string) => {
        const text = typeof buf === "string" ? buf : buf.toString("utf8");
        // Also keep writing to the parent stdout/stderr so `npm run dev` users see it live.
        (stream === "stdout" ? process.stdout : process.stderr).write(`[${id}] ${text}`);
        // Split on newlines so a 1-line-per-record JSONL stays clean, even when
        // opencode flushes a multi-line block in a single "data" event.
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          this.logDiag({ type: "_agent_log", agentId: id, stream, line });
        }
      };
      child.stdout?.on("data", teeLine("stdout"));
      child.stderr?.on("data", teeLine("stderr"));
      child.on("exit", (code) => {
        // Unit 38: child is dead; remove from PID log so startup
        // orphan-reclamation doesn't try to kill an already-dead pid
        // on the next restart. Fire-and-forget (best-effort).
        if (child?.pid !== undefined) {
          void this.pidTracker?.remove(child.pid);
        }
        if (this.agents.has(id)) {
          this.setAgentState({ ...stateBase, status: "stopped", error: `exited with code ${code}` });
          this.agents.delete(id);
          this.ports.release(port);
        }
      });

      await this.waitForReady(port, opts.readyTimeoutMs ?? 20_000);

      const baseUrl = `http://127.0.0.1:${port}`;
      const client = createOpencodeClient({ baseUrl, fetch: authedFetch, throwOnError: true });
      const created = await client.session.create({ body: { title: id } });
      const sessionId = this.readSessionId(created);
      if (!sessionId) throw new Error("session.create returned no session id");

      const agent: Agent = { id, index: opts.index, port, sessionId, client, child, model: opts.model };
      this.agents.set(id, agent);
      this.touchActivity(sessionId);
      // Unit 38: record this PID so the next dev-server startup can
      // reclaim it if this process or the current server dies without
      // a clean killAll. Only records AFTER session.create succeeded —
      // don't track subprocesses that failed to come up fully.
      if (child?.pid !== undefined) {
        void this.pidTracker?.add({
          spawnedAt: Date.now(),
          pid: child.pid,
          port,
          cwd: opts.cwd,
        });
      }
      this.startEventStream(agent);
      // Unit 17: warm the cloud shard before the runner sees this agent
      // as ready. If warmup fails (e.g. headers timeout on a stubborn
      // cold start), proceed anyway — even a failed warmup attempt has
      // told the cloud shard to start loading state on its end, so the
      // first real prompt is less cold than it would have been.
      // Unit 18: skipped when opts.skipWarmup is true (runner will warm
      // serially after the parallel spawn batch returns) or when
      // AGENT_WARMUP_ENABLED is false (unit-test rigs, etc).
      if (config.AGENT_WARMUP_ENABLED && !opts.skipWarmup) {
        await this.warmupAgent(agent);
      }
      this.setAgentState({ ...stateBase, sessionId, status: "ready" });
      return agent;
    } catch (err) {
      treeKill(child);
      this.ports.release(port);
      const msg = stringifyError(err);
      this.setAgentState({ ...stateBase, status: "failed", error: msg });
      throw err;
    }
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
    try {
      await agent.client.session.prompt({
        path: { id: agent.sessionId },
        body: {
          agent: "swarm",
          model: { providerID: "ollama", modelID: agent.model },
          parts: [{ type: "text", text: WARMUP_PROMPT_TEXT }],
        },
      });
      this.logDiag({ type: "_warmup_ok", agentId: agent.id, elapsedMs: Date.now() - t0 });
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

  // Task #39: per-agent partial-stream buffer. Updated on every
  // `message.part.updated` event with text content; cleared on
  // `session.idle` (stream finalized) and on killAll (run end).
  // getPartialStreams() returns a snapshot for the REST catch-up.
  private partialStreams = new Map<string, { text: string; updatedAt: number }>();

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
      try {
        await a.client.session.abort({ path: { id: a.sessionId } });
      } catch {
        // ignore
      }
      treeKill(a.child);
      // Unit 41: verified kill with two-stage escalation. We do NOT
      // return until every PID we spawned is confirmed dead, or we
      // have exhausted both stages. The /stop route awaits this, so
      // the HTTP response is an honest "all agents are gone" rather
      // than the old Unit 38 "fired the kill, hope it worked in 1.5 s".
      //
      // Stage 1 (up to 3 s): treeKill via ChildProcess, poll every
      //   300 ms with one retry at the 0.9 s mark.
      // Stage 2 (up to 3 s): killByPid (direct taskkill /F /PID or
      //   SIGTERM→SIGKILL on POSIX), poll every 300 ms. Bypasses the
      //   ChildProcess handle — catches cases where the Windows shell
      //   wrapper died but its opencode grandchild is still holding a
      //   port.
      // If both stages fail the PID is counted as "escaped" and the
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
        if (!dead) escaped += 1;
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

    void (async () => {
      let ended = false;
      try {
        this.logDiag({ type: "_sse_subscribed", agentId: agent.id, sessionId: agent.sessionId });
        const sub = await agent.client.event.subscribe({ signal: abort.signal });
        const stream = (sub as { stream: AsyncIterable<unknown> }).stream;
        for await (const ev of stream) {
          if (abort.signal.aborted) break;
          this.logRawSse(agent, ev);
          this.handleSessionEvent(agent, ev);
        }
        ended = true;
      } catch (err) {
        if (!abort.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${agent.id}] event stream ended:`, msg);
          // Surface to the event log so Claude can distinguish "stream died" from
          // "model was just slow" when diagnosing idle-watchdog trips.
          this.onEvent({
            type: "error",
            message: `SSE stream for ${agent.id} ended unexpectedly: ${msg}`,
          });
        }
      }
      // Graceful exit (for-await returned without throwing) while we were still
      // attached means the server closed the stream on its own — also worth
      // surfacing because the idle watchdog won't see any more events.
      if (ended && !abort.signal.aborted) {
        this.onEvent({
          type: "error",
          message: `SSE stream for ${agent.id} closed by server without abort`,
        });
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

    if (type === "message.part.updated") {
      const part = props.part as { type?: string; text?: string } | undefined;
      if (part?.type === "text" && typeof part.text === "string") {
        // Task #39: mirror the partial-stream text into a per-agent
        // buffer so the REST /api/swarm/status catch-up endpoint can
        // return it on page-refresh. Without this, hitting Ctrl-R
        // mid-stream lost the partial text entirely — only finalized
        // transcript entries survived. Cap at one buffer per agent;
        // successive partials overwrite.
        this.partialStreams.set(agent.id, {
          text: part.text,
          updatedAt: Date.now(),
        });
        this.onEvent({
          type: "agent_streaming",
          agentId: agent.id,
          agentIndex: agent.index,
          text: part.text,
        });
      }
      return;
    }
    if (type === "session.idle") {
      // Task #39: stream finalized, drop the partial buffer.
      this.partialStreams.delete(agent.id);
      this.onEvent({ type: "agent_streaming_end", agentId: agent.id });
      return;
    }
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
