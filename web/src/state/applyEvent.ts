// T-Item-PerRunStore (2026-05-04): SwarmEvent → SwarmStore mutation
// dispatcher. Extracted from useSwarmSocket so the per-run Provider's
// own WS subscription can dispatch into ITS store (vs the singleton).
//
// Pure routing logic — no module-level state. Caller passes the store
// (singleton OR per-run); we pull actions off it + invoke them.

import type { SwarmEvent } from "../types";
import type { SwarmStore } from "./store";

/** Apply ONE event to the supplied store's actions. The store's
 *  actions mutate it via zustand's set() so every subscriber re-
 *  renders. Pure with respect to module-level state. */
export function applyEventToStore(ev: SwarmEvent, s: SwarmStore): void {
  switch (ev.type) {
    case "transcript_append":
      s.appendEntry(ev.entry);
      break;
    case "agent_state":
      s.upsertAgent(ev.agent);
      break;
    case "swarm_state":
      s.setPhase(ev.phase, ev.round);
      break;
    case "agent_streaming":
      s.setStreaming(ev.agentId, ev.text);
      break;
    case "agent_streaming_end":
      s.markStreamingEnded(ev.agentId);
      break;
    case "error":
      s.setError(ev.message);
      break;
    case "todo_posted":
      s.upsertTodo(ev.todo);
      break;
    case "todo_claimed":
      s.applyClaim(ev.todoId, ev.claim);
      break;
    case "todo_committed":
      s.markCommitted(ev.todoId);
      break;
    case "todo_failed":
      s.markStale(ev.todoId, ev.reason, ev.replanCount);
      break;
    case "todo_skipped":
      s.markSkipped(ev.todoId, ev.reason);
      break;
    case "todo_replanned":
      s.applyReplan(
        ev.todoId,
        ev.description,
        ev.expectedFiles,
        ev.replanCount,
        ev.expectedAnchors,
      );
      break;
    case "finding_posted":
      s.appendFinding(ev.finding);
      break;
    case "queue_state":
      s.replaceBoard(ev.snapshot);
      break;
    case "contract_updated":
      s.setContract(ev.contract);
      break;
    case "run_summary":
      s.setSummary(ev.summary);
      break;
    case "agent_latency_sample":
      s.pushLatencySample(ev.agentId, {
        ts: ev.ts,
        elapsedMs: ev.elapsedMs,
        success: ev.success,
        attempt: ev.attempt,
      });
      break;
    case "conformance_sample":
      s.pushConformanceSample({
        ts: ev.ts,
        score: ev.score,
        smoothedScore: ev.smoothedScore,
        ...(ev.reason ? { reason: ev.reason } : {}),
        ...(ev.graderModel ? { graderModel: ev.graderModel } : {}),
        ...(typeof ev.latencyMs === "number" ? { latencyMs: ev.latencyMs } : {}),
        ...(typeof ev.excerptChars === "number" ? { excerptChars: ev.excerptChars } : {}),
        ...(Array.isArray(ev.windowScores) ? { windowScores: ev.windowScores } : {}),
      });
      break;
    case "directive_amended":
      s.pushAmendment({ ts: ev.ts, text: ev.text });
      break;
    case "drift_sample":
      s.pushDriftSample({
        ts: ev.ts,
        similarity: ev.similarity,
        smoothedSimilarity: ev.smoothedSimilarity,
        embeddingModel: ev.embeddingModel,
        excerptChars: ev.excerptChars,
        windowSimilarities: ev.windowSimilarities,
      });
      break;
    case "clone_state":
      s.setCloneState({
        alreadyPresent: ev.alreadyPresent,
        clonePath: ev.clonePath,
        priorCommits: ev.priorCommits,
        priorChangedFiles: ev.priorChangedFiles,
        priorUntrackedFiles: ev.priorUntrackedFiles,
      });
      break;
    case "pheromone_updated":
      s.upsertPheromone(ev.file, ev.state);
      break;
    case "mapper_slices":
      s.setMapperSlices(ev.slices);
      break;
    case "run_started":
      s.resetForNewRun({
        runId: ev.runId,
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        agentCount: ev.agentCount,
        repoUrl: ev.repoUrl,
      });
      s.setRunStartedAt(ev.startedAt);
      s.setRunId(ev.runId);
      s.setRunConfig({
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        auditorModel: ev.auditorModel,
        dedicatedAuditor: ev.dedicatedAuditor,
        roles: ev.roles,
        repoUrl: ev.repoUrl,
        clonePath: ev.clonePath,
        agentCount: ev.agentCount,
        rounds: ev.rounds,
        topology: ev.topology,
      });
      break;
  }
}
