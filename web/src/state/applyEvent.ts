// T-Item-PerRunStore (2026-05-04): SwarmEvent → SwarmStore mutation
// dispatcher. Extracted from useSwarmSocket so the per-run Provider's
// own WS subscription can dispatch into ITS store (vs the singleton).
//
// Pure routing logic — no module-level state. Caller passes the store
// (singleton OR per-run); we pull actions off it + invoke them.

import type { SwarmEvent } from "../types";
import type { SwarmStore } from "./store";
import { activityStubId, activityStubText } from "./agentActivityView";
import { isPreStreamActivityPhase } from "./agentActivityPhases";

/** Events without a runId field (global lifecycle) always apply.
 *  When the store has a runId, drop events stamped for another run.
 *  Tolerate short prefixes (e.g. "2ba626d5" vs full UUID) for run-layer binding
 *  since UI often displays/copies short slices but events use canonical full IDs. */
function shouldApplyEvent(ev: SwarmEvent, s: SwarmStore): boolean {
  const storeRunId = s.runId;
  if (!storeRunId) return true;
  const evRunId = (ev as { runId?: string }).runId;
  if (evRunId === undefined) return true;
  if (evRunId === storeRunId) return true;
  // prefix match (short in URL vs full in events, or vice versa)
  return evRunId.startsWith(storeRunId) || storeRunId.startsWith(evRunId);
}

/** Apply ONE event to the supplied store's actions. The store's
 *  actions mutate it via zustand's set() so every subscriber re-
 *  renders. Pure with respect to module-level state. */
export function applyEventToStore(ev: SwarmEvent, s: SwarmStore): void {
  if (!shouldApplyEvent(ev, s)) return;
  switch (ev.type) {
    case "transcript_append":
      s.appendEntry(ev.entry);
      break;
    case "agent_state":
      s.upsertAgent(ev.agent);
      break;
    case "agents_roster":
      s.replaceAgents(ev.agents);
      break;
    case "swarm_state":
      s.setPhase(ev.phase, ev.round, {
        ...(ev.planningSubphase ? { planningSubphase: ev.planningSubphase } : {}),
      });
      break;
    case "agent_streaming":
      s.setStreaming(ev.agentId, ev.text);
      break;
    case "agent_streaming_end":
      s.markStreamingEnded(ev.agentId);
      break;
    case "agent_activity":
      s.setAgentActivity(ev);
      if (isPreStreamActivityPhase(ev.phase)) {
        const stubId = activityStubId(ev.agentId);
        s.removeTranscriptEntry(stubId);
        s.appendEntry({
          id: stubId,
          role: "system",
          agentId: ev.agentId,
          agentIndex: ev.agentIndex,
          text: activityStubText(ev.agentIndex, ev.label, ev.phase, ev.reason, ev.agentId),
          ts: ev.ts,
        });
      } else if (ev.phase === "streaming") {
        s.removeTranscriptEntry(activityStubId(ev.agentId));
      } else if (ev.phase === "done") {
        s.removeTranscriptEntry(activityStubId(ev.agentId));
      }
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
    case "todo_proposed":
      if (ev.todo) s.upsertTodo(ev.todo);
      break;
    case "todo_reverted":
      // Authoritative update arrives via subsequent queue_state snapshot.
      // (We could optimistically adjust if we had prior claim info.)
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
    case "swarm_control_advice":
      s.pushControlAdvice({
        ts: ev.ts,
        kind: ev.kind,
        ...(ev.action ? { action: ev.action } : {}),
        ...(ev.source ? { source: ev.source } : {}),
        rationale: ev.rationale,
        ...(ev.plannerHint ? { plannerHint: ev.plannerHint } : {}),
        ...(ev.agentId ? { agentId: ev.agentId } : {}),
        ...(ev.tool ? { tool: ev.tool } : {}),
        ...(ev.conflictKind ? { conflictKind: String(ev.conflictKind) } : {}),
        ...(ev.status ? { status: String(ev.status) } : {}),
      });
      break;
    case "deliberation_transaction": {
      const tx = ev.transaction;
      if (tx && typeof tx === "object") {
        s.pushDeliberation({
          id: typeof tx.id === "string" ? tx.id : undefined,
          ts: typeof tx.ts === "number" ? tx.ts : Date.now(),
          layer: typeof tx.layer === "string" ? tx.layer : "peer",
          verdict: typeof tx.verdict === "string" ? tx.verdict : "claim",
          subject: typeof tx.subject === "string" ? tx.subject : "",
          ...(typeof tx.claim === "string" ? { claim: tx.claim } : {}),
          ...(typeof tx.validationReason === "string"
            ? { validationReason: tx.validationReason }
            : {}),
          ...(typeof tx.proposer === "string" ? { proposer: tx.proposer } : {}),
          ...(typeof tx.validator === "string" ? { validator: tx.validator } : {}),
        });
      }
      break;
    }
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
        ...(typeof ev.anchorOverlap === "number" ? { anchorOverlap: ev.anchorOverlap } : {}),
        ...(Array.isArray(ev.offGraphPaths) ? { offGraphPaths: ev.offGraphPaths } : {}),
        ...(ev.recoverySuggested ? { recoverySuggested: true } : {}),
      });
      break;
    case "directive_amended":
      s.pushAmendment({ ts: ev.ts, text: ev.text });
      break;
    case "run_reconfigured": {
      const patch: Record<string, unknown> = {};
      if (ev.changes.rounds) patch.rounds = ev.changes.rounds.to;
      if (ev.changes.wallClockCapMs) {
        patch.wallClockCapMin = String(Math.round(ev.changes.wallClockCapMs.to / 60_000));
      }
      // thinkGuardReferee RECONFIG retired (stream triage is deterministic).
      if (Object.keys(patch).length > 0) {
        s.patchRunConfig(patch as Parameters<typeof s.patchRunConfig>[0]);
      }
      // Transcript line comes from runner.appendSystemMessage → transcript_append.
      break;
    }
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
    case "model_shift":
      s.appendEntry({
        id: `model-shift-${ev.agentId}-${Date.now()}`,
        role: "system",
        agentId: ev.agentId,
        agentIndex: ev.agentIndex,
        text: `[${ev.agentId}] failover: ${ev.fromModel} → ${ev.toModel} (${ev.reason})${ev.rawError ? ` — ${ev.rawError}` : ""}`,
        ts: Date.now(),
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
      // Display full roster (topology length). Legacy blackboard agentCount
      // excludes dedicated auditor — UI "3 agents" vs AGENTS (4) is wrong.
      s.resetForNewRun({
        runId: ev.runId,
        preset: ev.preset,
        plannerModel: ev.plannerModel,
        workerModel: ev.workerModel,
        agentCount:
          (Array.isArray(ev.topology?.agents) && ev.topology.agents.length > 0
            ? ev.topology.agents.length
            : undefined)
          ?? (ev.dedicatedAuditor === true && typeof ev.agentCount === "number"
            ? ev.agentCount + 1
            : ev.agentCount),
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
        wallClockCapMin: ev.wallClockCapMin,
        ambitionTiers: ev.ambitionTiers,
        userDirective: ev.userDirective,
        plannerTools: ev.plannerTools,
        webTools: ev.webTools,
        mcpServers: ev.mcpServers,
      });
      break;

    case "outcome_scored":
      s.setOutcome({ score: ev.score, verdict: ev.verdict, dimensions: ev.dimensions });
      s.appendEntry({
        id: `outcome-${ev.runId}-${Date.now()}`,
        role: "system",
        text: `Run outcome: ${ev.verdict.toUpperCase()} · Score: ${ev.score.toFixed(1)}/10`,
        ts: Date.now(),
      });
      break;
  }
}
