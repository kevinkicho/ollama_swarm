import { createLogger, type LogContext } from "./logger.js";
import type { SwarmEvent } from "../types/run.js";
import fs from "node:fs";
import path from "node:path";

/**
 * RunEventHub organizes the previously diverse event pipes by functionality.
 *
 * Functional categories (for filtering, routing, debug, history):
 * - lifecycle: swarm_state, phase changes, start/stop
 * - agent: agent_state, streaming
 * - transcript: transcript_append, user messages
 * - todo / board: todo_* events (blackboard)
 * - brain: analysis, provision, insights (librarian role)
 * - diag: errors, logDiag, health
 * - usage: token/cost related (routed via proxy but can be emitted)
 *
 * All events get runId stamped for correlation.
 * Sinks can be registered for different purposes:
 *   - realtime: WS Broadcaster
 *   - persistent: EventLogger (history)
 *   - debug: structured logger
 *   - transcriptBuilder, persister, etc.
 *
 * This reduces "too many pipes" — components emit to the hub once.
 */

export type EventCategory =
  | "lifecycle"
  | "agent"
  | "transcript"
  | "todo"
  | "brain"
  | "diag"
  | "usage"
  | "other";

export interface EventSink {
  name: string;
  handle(event: SwarmEvent, category: EventCategory): void;
}

export interface RunEventHubOptions {
  runId: string;
  /** Optional request correlation from HTTP start */
  reqId?: string;
}

export class RunEventHub {
  private readonly log = createLogger();
  private readonly sinks: EventSink[] = [];
  private readonly runId: string;
  private readonly context: LogContext;

  constructor(opts: RunEventHubOptions) {
    this.runId = opts.runId;
    this.context = { runId: opts.runId, reqId: opts.reqId };
    this.log = this.log.withContext(this.context);
  }

  /**
   * Register a sink (e.g. broadcaster, eventLogger, debug writer).
   */
  registerSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  /**
   * Core emit. Stamps runId if missing. Routes to all sinks + structured log.
   * Auto-categorizes based on type for organization.
   */
  emit(event: Partial<SwarmEvent> & { type: string }, category?: EventCategory): void {
    const fullEvent: SwarmEvent = {
      runId: this.runId,
      ...event,
    } as SwarmEvent;

    const autoCategory = category || this.guessCategory(fullEvent.type);
    // Always log at debug level for correlation
    this.log.debug(`event:${fullEvent.type}`, {
      category: autoCategory,
      event: fullEvent,
    });

    for (const sink of this.sinks) {
      try {
        sink.handle(fullEvent, autoCategory);
      } catch (err) {
        this.log.warn(`sink ${sink.name} failed`, {
          error: err instanceof Error ? err.message : String(err),
          eventType: fullEvent.type,
        });
      }
    }
  }

  private guessCategory(type: string): EventCategory {
    if (type.startsWith("todo_") || type === "queue_state" || type === "board_") return "todo";
    if (type.includes("brain") || type === "analysis" || type === "provision") return "brain";
    if (type === "transcript_append" || type.startsWith("agent_stream")) return "transcript";
    if (type === "agent_state" || type === "swarm_state") return "lifecycle";
    if (type === "error" || type.includes("health")) return "diag";
    if (type.includes("token") || type.includes("cost")) return "usage";
    return "other";
  }

  /**
   * Convenience for common categories.
   */
  emitLifecycle(event: Partial<SwarmEvent> & { type: string }) {
    this.emit(event, "lifecycle");
  }

  emitAgent(event: Partial<SwarmEvent> & { type: string }) {
    this.emit(event, "agent");
  }

  emitTranscript(event: Partial<SwarmEvent> & { type: string }) {
    this.emit(event, "transcript");
  }

  emitBrain(event: Partial<SwarmEvent> & { type: string }) {
    this.emit(event, "brain");
  }

  emitDiag(event: Partial<SwarmEvent> & { type: string }) {
    this.emit(event, "diag");
  }

  getRunId(): string {
    return this.runId;
  }
}

/**
 * Example sink adapters (to be wired in index.ts / Orchestrator).
 */
export function createBroadcasterSink(broadcaster: { broadcast: (e: SwarmEvent) => void }): EventSink {
  return {
    name: "broadcaster",
    handle(event) {
      broadcaster.broadcast(event);
    },
  };
}

export function createEventLoggerSink(logger: { log: (e: unknown) => void }): EventSink {
  return {
    name: "eventLogger",
    handle(event) {
      logger.log(event);
    },
  };
}

/**
 * Simple debug sink: writes categorized events to a per-run debug file.
 * E.g. logs/<runId>/debug.jsonl
 * Useful for detailed debugging without flooding main event log.
 */
export function createDebugSink(runId: string, baseLogDir: string = "logs"): EventSink {
  const dir = path.join(baseLogDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const debugPath = path.join(dir, "debug.jsonl");
  const stream = fs.createWriteStream(debugPath, { flags: "a", encoding: "utf8" });

  return {
    name: "debug",
    handle(event: SwarmEvent, category: EventCategory) {
      try {
        stream.write(JSON.stringify({ ts: Date.now(), category, event }) + "\n");
      } catch {
        // best effort
      }
    },
  };
}
