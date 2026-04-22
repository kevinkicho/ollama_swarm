import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config, basicAuthHeader } from "../config.js";
import { PortAllocator } from "./PortAllocator.js";
import { treeKill } from "./treeKill.js";
import type { AgentState, SwarmEvent } from "../types.js";

type Client = ReturnType<typeof createOpencodeClient>;

export interface Agent {
  id: string;
  index: number;
  port: number;
  sessionId: string;
  client: Client;
  child?: ChildProcess;
  model: string;
}

export interface SpawnOpts {
  cwd: string;
  index: number;
  model: string;
  readyTimeoutMs?: number;
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
  private orchestratorClient?: Client;

  constructor(
    private readonly onState: (s: AgentState) => void,
    private readonly onEvent: (e: SwarmEvent) => void = () => {},
    // Diagnostic-only sink for records we don't want to broadcast over WS but
    // DO want in logs/current.jsonl (opencode stdout/stderr, raw SSE events).
    // Separate from onEvent to keep SwarmEvent honestly typed.
    private readonly logDiag: (record: unknown) => void = () => {},
  ) {}

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
    return this.list().map((a) => ({
      id: a.id,
      index: a.index,
      port: a.port,
      sessionId: a.sessionId,
      status: "ready",
    }));
  }

  async spawnAgent(opts: SpawnOpts): Promise<Agent> {
    const port = await this.ports.allocate();
    const id = `agent-${opts.index}`;
    const stateBase: AgentState = { id, index: opts.index, port, status: "spawning" };
    this.onState(stateBase);

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
        if (this.agents.has(id)) {
          this.onState({ ...stateBase, status: "stopped", error: `exited with code ${code}` });
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
      this.startEventStream(agent);
      this.onState({ ...stateBase, sessionId, status: "ready" });
      return agent;
    } catch (err) {
      treeKill(child);
      this.ports.release(port);
      const msg = err instanceof Error ? err.message : String(err);
      this.onState({ ...stateBase, status: "failed", error: msg });
      throw err;
    }
  }

  markStatus(id: string, status: AgentState["status"], extra: Partial<AgentState> = {}): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.onState({ id, index: a.index, port: a.port, sessionId: a.sessionId, status, ...extra });
  }

  async killAll(): Promise<void> {
    for (const ctrl of this.eventAborts.values()) ctrl.abort();
    this.eventAborts.clear();
    const tasks = [...this.agents.values()].map(async (a) => {
      try {
        await a.client.session.abort({ path: { id: a.sessionId } });
      } catch {
        // ignore
      }
      treeKill(a.child);
      this.ports.release(a.port);
      this.lastActivity.delete(a.sessionId);
      this.onState({ id: a.id, index: a.index, port: a.port, sessionId: a.sessionId, status: "stopped" });
    });
    await Promise.allSettled(tasks);
    this.agents.clear();
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
      this.onEvent({ type: "agent_streaming_end", agentId: agent.id });
      return;
    }
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
