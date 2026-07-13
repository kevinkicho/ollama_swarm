import { createLogger, type LogContext } from "./logger.js";
import type { SwarmEvent } from "../types/run.js";
import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";

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
    // agent_streaming is data-plane (media); agent_activity is control-plane session.
    if (type === "transcript_append" || type.startsWith("agent_stream")) return "transcript";
    if (
      type === "agent_activity"
      || type === "agent_state"
      || type === "agents_roster"
      || type === "swarm_state"
    ) {
      return "agent";
    }
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
 *
 * Includes basic size-based rotation (similar to the global current.jsonl)
 * so a single very long autonomous run doesn't produce a 100MB+ debug file.
 */
const DEBUG_MAX_BYTES = config.DEBUG_MAX_BYTES;
const DEBUG_CHECK_INTERVAL = 100;

export function createDebugSink(runId: string, baseLogDir: string = "logs"): EventSink {
  const dir = path.join(baseLogDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  let debugPath = path.join(dir, "debug.jsonl");
  let stream = fs.createWriteStream(debugPath, { flags: "a", encoding: "utf8" });
  let writeCount = 0;

  function maybeRotateDebug() {
    if (writeCount % DEBUG_CHECK_INTERVAL !== 0) return;
    try {
      const stat = fs.statSync(debugPath);
      if (stat.size < DEBUG_MAX_BYTES) return;
      const iso = new Date().toISOString().replace(/[:.]/g, "-");
      const archived = path.join(dir, `debug-${iso}.jsonl`);
      fs.renameSync(debugPath, archived);
      // Compress archived debug log too (matching global log behavior)
      const gzPath = `${archived}.gz`;
      pipeline(fs.createReadStream(archived), createGzip(), fs.createWriteStream(gzPath))
        .then(() => { try { fs.unlinkSync(archived); } catch {} })
        .catch(() => {});
      // reopen
      try { stream.end(); } catch {}
      debugPath = path.join(dir, "debug.jsonl");
      stream = fs.createWriteStream(debugPath, { flags: "a", encoding: "utf8" });
    } catch {
      // ignore
    }
  }

  return {
    name: "debug",
    handle(event: SwarmEvent, category: EventCategory) {
      try {
        stream.write(JSON.stringify({ ts: Date.now(), category, event }) + "\n");
        writeCount++;
        maybeRotateDebug();
        // When a run summary lands, refresh debug.meta.json for fast Debug Log list.
        const ev = event as { type?: string; summary?: { stopReason?: string; preset?: string; startedAt?: number; endedAt?: number } };
        if (ev.type === "run_summary" || ev.type === "run_finished") {
          void (async () => {
            try {
              const { writeDebugMetaSidecar } = await import(
                "../swarm/blackboard/eventLogSources.js"
              );
              const st = fs.statSync(debugPath);
              const summary = ev.summary;
              await writeDebugMetaSidecar(baseLogDir, {
                runId,
                bytes: st.size,
                lineCount: writeCount,
                derived: {
                  runId,
                  preset: summary?.preset,
                  startedAt: summary?.startedAt,
                  finishedAt: summary?.endedAt ?? Date.now(),
                  stopReason: summary?.stopReason,
                  hasSummary: true,
                  errors: [],
                  transcriptCount: 0,
                  agentStateUpdates: 0,
                  agentActivityEvents: 0,
                  activityTimeline: [],
                  phaseTimeline: [],
                  eventTypeCounts: {},
                  modelShiftCount: 0,
                  brainFallbackCount: 0,
                  todoClaimed: 0,
                  todoFailed: 0,
                  todoReplanned: 0,
                  todoSkipped: 0,
                  streamingEventCount: 0,
                  streamingEndCount: 0,
                  amendmentCount: 0,
                  conformanceSampleCount: 0,
                  driftSampleCount: 0,
                  coldStartCount: 0,
                  streamAnomalies: [],
                  anomalyFlags: [],
                } as import("../swarm/blackboard/EventLogReaderV2.js").DerivedRunState,
              });
            } catch {
              /* best effort */
            }
          })();
        }
      } catch {
        // best effort
      }
    },
  };
}
