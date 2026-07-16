// Extracted from BlackboardRunner.ts — worker poll loop + hunks pipeline.
// Manages runWorkers, runWorker, executeBuildTodo, executeWorkerTodo,
// and maybeSettleHypothesisGroup. Takes a narrow WorkerContext object
// instead of referencing `this.*`.

import type { Agent } from "../../services/AgentManager.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { Todo, ExitContract, BoardEvent } from "./types.js";
import type { Hunk } from "./applyHunks.js";
import type { QueuedTodo, TodoQueue } from "./TodoQueue.js";
import type { AgentStatus } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { AgentState } from "../../types.js";
import type { CandidateForConflict } from "./hypothesisGrouping.js";
import {
  WORKER_POLL_MS,
  WORKER_POLL_JITTER_MS,
  WORKER_COOLDOWN_MS,
} from "./BlackboardRunnerConstants.js";
import {
  evaluateConflictDispatch,
  updateDeferralTimestamps,
} from "./hypothesisGrouping.js";
import { hasActiveFileConflict } from "./workerFileConflict.js";
import {
  buildHunkRepairPrompt,
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  isLiteratureTodo,
  parseWorkerResponse,
  validateHunkPayload,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
  WorkerResponseSchema,
} from "./prompts/worker.js";

import { extractText } from "../extractText.js";
import { isWebToolsEnabled } from "../toolProfiles.js";
import { type ToolTraceEntry } from "../toolCallTranscript.js";
import { DISPOSITIONS, type RoundRobinDisposition, getDispositionForTurn } from "../roundRobinPromptHelpers.js";
import { WORKER_HUNKS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { applyAndCommit } from "./WorkerPipeline.js";
import { realFilesystemAdapter, realGitAdapter, realVerifyAdapter } from "./v2Adapters.js";
import { voteOnHunksWithJudge, type HunkVote, type JudgeFn } from "./hunkVoting.js";
import { buildJudgePrompt } from "./hunkJudgePrompt.js";

import { v2QueueTodoToWireTodo } from "./boardWireCompat.js";
import { bumpAgentCounter } from "./runnerHelpers.js";
import { pheromoneHeatmap } from "../pheromoneHeatmap.js";
import { withSiblingRetry } from "./siblingRetry.js";
import { verifyWorkerSkip } from "./auditorRunner.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import type { TranscriptEntry } from "../../types.js";
import { autoDetectAnchors } from "./autoAnchor.js";
import { getModelBudget } from "../modelContextBudget.js";
import { profileTools, resolveToolProfile } from "../toolProfiles.js";
import {
  loadEndpointCatalogSnapshot,
  renderEndpointCatalogBlock,
  todoTouchesApiSurface,
} from "./endpointCatalogContext.js";
import { runParseSalvage } from "./parseSalvage.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { resolveWorkerScaffoldPlan } from "./workerScaffold.js";
import { isPromptHaltError } from "./lifecycleState.js";
import type { AgentManager } from "../../services/AgentManager.js";
import { executeBuildTodo as executeBuildTodoImpl } from "./workerBuildTodo.js";
import { maybeSettleHypothesisGroup as maybeSettleHypothesisGroupImpl } from "./workerHypothesisSettle.js";
import { prepareWorkerTodoSeed } from "./workerTodoPrep.js";
import { runWorkerParseCascade } from "./workerParseCascade.js";
import { handleWorkerSkip } from "./workerSkipAudit.js";
import { finalizeWorkerHunks } from "./workerSelfConsistency.js";

function workerToolProfile(ctx: WorkerContext, kind: "hunk" | "build" | "read"): ProfileName {
  const cfg = ctx.getActive();
  if (kind === "build") return resolveToolProfile("worker-build", cfg);
  if (kind === "read") return resolveToolProfile("read", cfg);
  return resolveToolProfile("worker", cfg);
}

export interface WorkerContext {
  isStopping: () => boolean;
  isDraining: () => boolean;
  getActiveAborts: () => Set<AbortController>;
  isPaused: () => boolean;
  isSubscriberPaused: () => boolean;
  isMemoryPaused: () => boolean;
  checkAndApplyCaps: () => boolean;
  boardCounts: () => { open: number; claimed: number; stale: number; committed: number; skipped: number; total: number };
  getActive: () => RunConfig | undefined;
  getTranscript: () => readonly TranscriptEntry[];
  getAmendments?: () => Array<{ ts: number; text: string }>;
  getReplanPending: () => Set<string>;
  isReplanRunning: () => boolean;
  getWrappers: () => TodoQueueWrappers;
  getTodoQueue: () => TodoQueue;
  getWorkerPool: () => Agent[];
  getWorkerRoles: () => Map<string, string>;
  getFileCommitCounts: () => Map<string, number>;
  setFileCommitCounts: (v: Map<string, number>) => void;
  getHypothesisGroupAborts: () => Map<string, AbortController>;
  getHypothesisDeferralTimestamps: () => Map<string, number>;
  setHypothesisDeferralTimestamps: (v: Map<string, number>) => void;
  getAuditor: () => Agent | undefined;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: "auditor-salvage"; role?: "worker" | "general" },
  ) => void;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
  promptAgent: (
    agent: Agent,
    prompt: string,
    agentName: ProfileName,
    formatExpect: "json" | "free",
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: {
      kind?: string;
      label?: string;
      maxToolTurns?: number;
      mode?: "explore" | "emit";
      promptWallClockMs?: number;
    },
  ) => Promise<string>;
  getRepoFiles?: () => readonly string[];
  emitAgentState: (s: AgentState) => void;
  getManager: () => AgentManager;
  readExpectedFiles: (files: string[]) => Promise<Record<string, string | null>>;
  sleep: (ms: number) => Promise<void>;
  markStatus: (agentId: string, status: AgentStatus, meta?: Record<string, unknown>) => void;
  anyAgentThinking: () => boolean;
  logDiag: (entry: Record<string, unknown>) => void;
  emit: (ev: BoardEvent | Record<string, unknown>) => void;
  maybeSettleHypothesisGroup: (todoId: string) => void;
  bumpStaleEventCount: () => void;
  enqueueReplan: (todoId: string) => void;
  // Commit/stat tracking callbacks
  bumpCommitsPerAgent: (agentId: string) => void;
  addLinesPerAgent: (agentId: string, added: number, removed: number) => void;
  recordCriterionCommits: (todo: Todo, commitSha: string) => void;
  // Plan 4: post-run brain overseer telemetry
  recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => void;
  recordException: (type: string, agentId: string, todoId?: string, reason?: string) => void;
  bumpStigmergyFileCounts: (expectedFiles: readonly string[], commitSha: string) => void;
  // Build-todo specific: repos access for git status + commit
  gitStatus: (clonePath: string) => Promise<{ porcelain: string; changedFiles: number }>;
  commitAll: (clonePath: string, message: string) => Promise<void>;
  // Per-agent stat bumping (bumpAgentCounter wrapper)
  bumpRejectedAttempts: (agentId: string) => void;
  bumpJsonRepairs: (agentId: string) => void;
  bumpPromptErrors: (agentId: string) => void;
  // Self-consistency K
  getSelfConsistencyK: () => number;
  // Plan 6: round-robin dispositions
  getDispositionCycle: () => Map<string, number>;
  setDispositionCycle: (v: Map<string, number>) => void;
  // Plan 3: pheromone heatmap access for hot-files seeding
  getPheromoneHeatmap: () => import("../pheromoneHeatmap.js").PheromoneHeatmap | undefined;
  updateAgentModel: (agentId: string, model: string) => void;
  getPlannerFallbackModel: () => string | undefined;
}

/** Pure helper: workers should stop polling when nothing is claimable
 *  and no in-flight prompt/replan work remains — even if orphaned
 *  in-progress or pending-commit todos still exist (auditor's job). */
export function workersShouldDrain(input: {
  pending: number;
  stale: number;
  replanPending: number;
  replanRunning: boolean;
  anyThinking: boolean;
}): boolean {
  if (input.pending > 0) return false;
  if (input.stale > 0) return false;
  if (input.replanPending > 0) return false;
  if (input.replanRunning) return false;
  if (input.anyThinking) return false;
  return true;
}

export async function runWorkers(
  ctx: WorkerContext,
  workers: Agent[],
): Promise<void> {
  await Promise.all(workers.map((w) => runWorker(ctx, w)));
}

export async function runWorker(
  ctx: WorkerContext,
  agent: Agent,
): Promise<void> {
  let waitTickN = 0;
  let lastWaitDiagAt = 0;
  while (!ctx.isStopping()) {
    const jitter = Math.floor(Math.random() * WORKER_POLL_JITTER_MS);
    await ctx.sleep(WORKER_POLL_MS + jitter);
    if (ctx.isStopping()) return;

    if (ctx.checkAndApplyCaps()) return;
    if (ctx.isPaused() || ctx.isSubscriberPaused() || ctx.isMemoryPaused()) continue;
    if (ctx.isDraining()) return;

    const counts = ctx.boardCounts();
    const qCounts = ctx.getTodoQueue().counts();
    if (
      workersShouldDrain({
        pending: qCounts.pending,
        stale: counts.stale,
        replanPending: ctx.getReplanPending().size,
        replanRunning: ctx.isReplanRunning(),
        anyThinking: ctx.anyAgentThinking(),
      })
    ) {
      return;
    }

    ctx.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    ctx.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });

    if (counts.open === 0) {
      waitTickN += 1;
      const now = Date.now();
      const PERSISTENT_WEDGE_MIN_TICKS = 12;
      const someoneInFlight = ctx.anyAgentThinking();
      const sustainedWedge = waitTickN >= PERSISTENT_WEDGE_MIN_TICKS && !someoneInFlight;
      if (sustainedWedge && now - lastWaitDiagAt > 30_000) {
        lastWaitDiagAt = now;
        ctx.logDiag({
          type: "_worker_wait_wedge",
          agentId: agent.id,
          tickN: waitTickN,
          counts: { ...counts },
          replanPending: Array.from(ctx.getReplanPending()),
          replanRunning: ctx.isReplanRunning(),
          ts: now,
        });
        if (waitTickN === PERSISTENT_WEDGE_MIN_TICKS) {
          ctx.appendSystem(
            `[${agent.id}] worker idle ${Math.round(waitTickN * (WORKER_POLL_MS + WORKER_POLL_JITTER_MS / 2) / 1000)}s but exit-condition not met: ` +
              `claimed=${counts.claimed} stale=${counts.stale} ` +
              `replanPending=${ctx.getReplanPending().size} replanRunning=${ctx.isReplanRunning()}`,
          );
        }
      }
      continue;
    } else {
      waitTickN = 0;
    }

    const myTag = ctx.getActive()?.topology?.agents.find((a) => a.index === agent.index)?.tag;
    const useHypothesisCheck = ctx.getActive()?.parallelHypothesisInFlight;
    const useStigmergy = ctx.getActive()?.stigmergyOnBlackboard;

    let queued: QueuedTodo | null;
    if (useHypothesisCheck || useStigmergy) {
      const stigmergyCounts = ctx.getFileCommitCounts();
      const allTodos = ctx.getTodoQueue().list();
      const candidates: CandidateForConflict[] = allTodos.map((t) => ({
        id: t.id,
        groupId: t.groupId ?? null,
        expectedFiles: t.expectedFiles,
        status: t.status === "in-progress" ? "in-progress" : t.status,
      }));
      const globalInProgress = candidates.filter((c) => c.status === "in-progress");
      const now = Date.now();
      const verdictsByTodoId = new Map<string, "dispatch" | "defer" | "force-dispatch">();

      queued = ctx.getTodoQueue().dequeueByScore(agent.id, (t) => {
        let stigmergyBias = 0;
        if (useStigmergy) {
          let touched = 0;
          for (const f of t.expectedFiles) touched += stigmergyCounts.get(f) ?? 0;
          stigmergyBias = -touched;
        }
        if (hasActiveFileConflict(t.expectedFiles, globalInProgress, t.id)) {
          return Number.NEGATIVE_INFINITY;
        }
        if (useHypothesisCheck && t.groupId) {
          const candidate = candidates.find((c) => c.id === t.id);
          if (!candidate) return -999_999;
          const groupSiblings = candidates.filter((c) => c.groupId === t.groupId);
          const verdict = evaluateConflictDispatch({
            candidate,
            groupSiblings,
            deferralTimestamps: ctx.getHypothesisDeferralTimestamps(),
            now,
          });
          verdictsByTodoId.set(t.id, verdict);
          if (verdict === "defer") return Number.NEGATIVE_INFINITY;
          const baseScore = verdict === "force-dispatch" ? 1000 : 0;
          return baseScore + stigmergyBias;
        }
        return stigmergyBias;
      });

      if (useHypothesisCheck) {
        for (const [todoId, verdict] of verdictsByTodoId.entries()) {
          const effectiveVerdict = queued && queued.id === todoId ? "dispatch" : verdict;
          ctx.setHypothesisDeferralTimestamps(
            updateDeferralTimestamps({
              candidateId: todoId,
              verdict: effectiveVerdict,
              current: ctx.getHypothesisDeferralTimestamps(),
              now,
            }),
          );
        }
        if (queued && verdictsByTodoId.get(queued.id) === "force-dispatch") {
          ctx.appendSystem(
            `[T-Item-HypTimeout] force-dispatched ${queued.id.slice(0, 8)} after ${(5 * 60_000) / 1000}s deferral (group ${queued.groupId}); CAS may revert if sibling commits first.`,
          );
        }
      }

      if (queued) {
        const wire = v2QueueTodoToWireTodo(queued);
        if (wire.claim) {
          ctx.emit({
            type: "todo_claimed",
            todoId: queued.id,
            claim: wire.claim,
          });
        }
      }
    } else {
      const allTodos = ctx.getTodoQueue().list();
      const inProgress = allTodos
        .filter((t) => t.status === "in-progress")
        .map((t) => ({ id: t.id, expectedFiles: t.expectedFiles }));
      if (inProgress.length > 0) {
        queued = ctx.getTodoQueue().dequeueByScore(agent.id, (t) => {
          if (t.status !== "pending") return -999_999;
          if (hasActiveFileConflict(t.expectedFiles, inProgress, t.id)) {
            return Number.NEGATIVE_INFINITY;
          }
          return 0;
        });
        if (queued) {
          const wire = v2QueueTodoToWireTodo(queued);
          if (wire.claim) {
            ctx.emit({
              type: "todo_claimed",
              todoId: queued.id,
              claim: wire.claim,
            });
          }
        }
      } else {
        queued = ctx.getWrappers().dequeueTodoQ(agent.id, myTag);
      }
    }

    if (!queued) continue;
    const todo = v2QueueTodoToWireTodo(queued);

    let outcome: "committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped";
    if (todo.kind === "build") {
      outcome = await executeBuildTodo(ctx, agent, todo);
    } else {
      outcome = await executeWorkerTodo(ctx, agent, todo);
    }
    if (outcome === "committed") {
      await ctx.sleep(WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500));
    }
    if (outcome === "aborted") {
      const qt = ctx.getTodoQueue().get(todo.id);
      if (qt?.status === "in-progress") {
        ctx.getWrappers().skipTodoQ(todo.id, "aborted during stop/drain");
      }
      ctx.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
      ctx.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
    }
  }
}

export async function executeBuildTodo(
  ctx: WorkerContext,
  agent: Agent,
  todo: Todo,
): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> {
  return executeBuildTodoImpl(ctx, agent, todo);
}

export function maybeSettleHypothesisGroup(
  ctx: WorkerContext,
  todoId: string,
): void {
  maybeSettleHypothesisGroupImpl(ctx, todoId);
}

export async function executeWorkerTodo(
  ctx: WorkerContext,
  agent: Agent,
  todo: Todo,
): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> {
  const modelAtEntry = agent.model;
  let commitTier: import("./types.js").CommitTier | undefined;

  const prep = await prepareWorkerTodoSeed(ctx, agent, todo);
  if (!prep.ok) return prep.outcome;
  const { seed, scaffoldPlan, contents } = prep;

  const workerProfile = scaffoldPlan?.profile ?? workerToolProfile(ctx, "hunk");
  const workerPromptParts = [WORKER_SYSTEM_PROMPT];
  if (scaffoldPlan?.scaffoldBlock) workerPromptParts.push(scaffoldPlan.scaffoldBlock);
  workerPromptParts.push(buildWorkerUserPrompt(seed));
  const workerActivity = {
    kind: "worker",
    label: `todo ${todo.id.slice(0, 8)}`,
    ...(scaffoldPlan
      ? { mode: "emit" as const, maxToolTurns: 0, promptWallClockMs: scaffoldPlan.promptWallClockMs }
      : {}),
  };

  let response: string;
  try {
    response = await ctx.promptAgent(
      agent,
      `${workerPromptParts.join("\n\n")}`,
      workerProfile,
      "json",
      WORKER_HUNKS_JSON_SCHEMA,
      workerActivity,
    );
  } catch (err) {
    if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) return "aborted";
    const msg = err instanceof Error ? err.message : String(err);
    ctx.getWrappers().failTodoQ(todo.id, `[v2] worker prompt failed: ${msg}`, "prompt-fail");
    ctx.bumpPromptErrors(agent.id);
    ctx.bumpRejectedAttempts(agent.id);
    return "stale";
  }
  if (ctx.isStopping()) return "aborted";
  ctx.appendAgent(agent, response, { role: "worker" });

  const parseResult = await runWorkerParseCascade(
    {
      isStopping: ctx.isStopping,
      isDraining: ctx.isDraining,
      getWrappers: ctx.getWrappers,
      getAuditor: ctx.getAuditor,
      getActive: ctx.getActive,
      appendSystem: ctx.appendSystem,
      appendAgent: ctx.appendAgent,
      promptAgent: ctx.promptAgent,
      bumpJsonRepairs: ctx.bumpJsonRepairs,
      bumpPromptErrors: ctx.bumpPromptErrors,
      bumpRejectedAttempts: ctx.bumpRejectedAttempts,
      updateAgentModel: ctx.updateAgentModel,
      emit: ctx.emit,
      getPlannerFallbackModel: ctx.getPlannerFallbackModel,
      workerToolProfile: (kind) => workerToolProfile(ctx, kind),
    },
    agent,
    todo,
    seed,
    response,
    workerProfile,
    workerActivity,
    modelAtEntry,
  );
  if (!parseResult.ok) return parseResult.outcome;
  let parsed = parseResult.parsed;
  commitTier = parseResult.commitTier;

  if (parsed.skip) {
    return handleWorkerSkip(
      {
        getActive: ctx.getActive,
        getWrappers: ctx.getWrappers,
        getAuditor: ctx.getAuditor,
        appendSystem: ctx.appendSystem,
        appendAgent: ctx.appendAgent,
        promptAgent: ctx.promptAgent,
        readExpectedFiles: ctx.readExpectedFiles,
        bumpRejectedAttempts: ctx.bumpRejectedAttempts,
        recordInteraction: ctx.recordInteraction,
        recordException: ctx.recordException,
        workerToolProfile: (kind) => workerToolProfile(ctx, kind),
      },
      agent,
      todo,
      parsed.skip,
    );
  }

  const fin = await finalizeWorkerHunks(
    {
      isStopping: ctx.isStopping,
      isDraining: ctx.isDraining,
      getActive: ctx.getActive,
      getWrappers: ctx.getWrappers,
      getWorkerPool: ctx.getWorkerPool,
      getAuditor: ctx.getAuditor,
      getSelfConsistencyK: ctx.getSelfConsistencyK,
      appendSystem: ctx.appendSystem,
      appendAgent: ctx.appendAgent,
      promptAgent: ctx.promptAgent,
      bumpJsonRepairs: ctx.bumpJsonRepairs,
      bumpPromptErrors: ctx.bumpPromptErrors,
      bumpRejectedAttempts: ctx.bumpRejectedAttempts,
      workerToolProfile: (kind) => workerToolProfile(ctx, kind),
    },
    agent,
    todo,
    seed,
    response,
    parsed,
    commitTier,
  );
  // finalizeWorkerHunks proposes for auditor (pending-commit) or returns stale/aborted.
  return fin.outcome;
}