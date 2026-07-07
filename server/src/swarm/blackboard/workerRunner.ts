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
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
  WorkerResponseSchema,
} from "./prompts/worker.js";
import { buildResearchToolsNote } from "./prompts/planner.js";
import { chatOnce } from "../chatOnce.js";
import { extractText } from "../extractText.js";
import { isWebToolsEnabled } from "../toolProfiles.js";
import { makeWebToolHandler } from "../toolCallTranscript.js";
import { DISPOSITIONS, type RoundRobinDisposition, getDispositionForTurn } from "../roundRobinPromptHelpers.js";
import { WORKER_HUNKS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { checkBuildCommand } from "./buildCommandAllowlist.js";
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
import { isPromptHaltError } from "./lifecycleState.js";

function workerToolProfile(ctx: WorkerContext, kind: "hunk" | "build" | "read"): ProfileName {
  const cfg = ctx.getActive();
  if (kind === "build") return resolveToolProfile("worker-build", cfg);
  if (kind === "read") return resolveToolProfile("read", cfg);
  return resolveToolProfile("worker", cfg);
}

async function runWorkerLiteratureResearch(
  ctx: WorkerContext,
  agent: Agent,
  todo: { description: string; expectedFiles: string[] },
  clonePath: string,
): Promise<string | undefined> {
  const cfg = ctx.getActive();
  if (!cfg || !isWebToolsEnabled(cfg) || !isLiteratureTodo(todo.description)) {
    return undefined;
  }
  const profile = workerToolProfile(ctx, "read");
  const litExtras = resolveBlackboardPromptExtras({
    active: cfg,
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: agent.id,
  });
  const litDirective = litExtras.effectiveDirective ?? cfg.userDirective;
  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    litDirective ? `User directive: ${litDirective}` : "",
    "",
    "Use web_search and web_fetch to gather citable findings. Output plain prose with bullet points and URLs.",
    "Do NOT emit JSON hunks in this phase.",
  ].filter(Boolean).join("\n");

  try {
    const res = await chatOnce(agent, {
      agentName: profile,
      promptText: prompt,
      clonePath,
      webToolsConfig: cfg,
      runId: cfg.runId,
      mcpServers: cfg.mcpServers,
      onTool: makeWebToolHandler(ctx.appendSystem, agent.id),
    });
    const text = extractText(res)?.trim();
    if (text && text.length >= 80) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      ctx.appendSystem(`[${agent.id}] Literature research: captured ${capped.length} chars of notes.`);
      return capped;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
  }
  return undefined;
}

export interface WorkerContext {
  isStopping: () => boolean;
  isDraining: () => boolean;
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
  appendAgent: (agent: Agent, text: string, options?: { assistKind?: "auditor-salvage" }) => void;
  promptAgent: (agent: Agent, prompt: string, agentName: ProfileName, formatExpect: "json" | "free", ollamaFormat?: "json" | Record<string, unknown>) => Promise<string>;
  emitAgentState: (s: AgentState) => void;
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
  if (!todo.command || todo.command.trim().length === 0) {
    ctx.appendSystem(`[${agent.id}] build TODO ${todo.id.slice(0, 8)} has no command — marking stale.`);
    ctx.getWrappers().failTodoQ(todo.id, "build TODO missing command field");
    return "stale";
  }

  const check = checkBuildCommand(todo.command);
  if (!check.ok) {
    ctx.appendSystem(
      `[${agent.id}] build TODO ${todo.id.slice(0, 8)} command refused by allowlist: ${check.reason}`,
    );
    ctx.getWrappers().failTodoQ(todo.id, `build command not allowed: ${check.reason}`);
    return "stale";
  }
  ctx.appendSystem(
    `[${agent.id}] running build command for todo ${todo.id.slice(0, 8)}: \`${todo.command}\` (binary: ${check.binary})`,
  );

  const clonePath = ctx.getActive()?.localPath;
  if (!clonePath) {
    ctx.getWrappers().failTodoQ(todo.id, "no localPath — runner state corrupt");
    return "stale";
  }

  const buildPrompt = [
    "You are a build worker. Your job is to run ONE shell command via the bash tool.",
    "",
    `Command to run: ${todo.command}`,
    `Working directory: ${clonePath}`,
    "",
    "Steps:",
    "1. Invoke the bash tool with the EXACT command above. Do not modify, prefix, or chain.",
    "2. After the command completes, respond with this JSON envelope and NOTHING ELSE:",
    `   {"ok": true|false, "exitCode": <number>, "summary": "<one-line summary of what changed>"}`,
    "",
    "If the command exits non-zero, set ok=false. Do not edit files manually — bash side effects are the entire delivery mechanism.",
  ].join("\n");

  let response: string;
  try {
    response = await ctx.promptAgent(agent, buildPrompt, workerToolProfile(ctx, "build"), "json", "json");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] build prompt failed: ${msg.slice(0, 120)}`);
    ctx.getWrappers().failTodoQ(todo.id, `build prompt failed: ${msg.slice(0, 200)}`);
    return "stale";
  }
  ctx.appendAgent(agent, response);

  const dirty = await ctx.gitStatus(clonePath);
  if (!dirty.changedFiles || dirty.changedFiles === 0) {
    ctx.appendSystem(
      `[${agent.id}] build command ran but working tree is clean — marking todo stale.`,
    );
    ctx.getWrappers().failTodoQ(todo.id, "build command produced no file changes");
    return "stale";
  }

  try {
    await ctx.commitAll(clonePath, `build: ${todo.description.slice(0, 80)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] git commit failed: ${msg.slice(0, 120)}`);
    ctx.getWrappers().failTodoQ(todo.id, `git commit failed: ${msg.slice(0, 200)}`);
    return "stale";
  }

  ctx.getWrappers().completeTodoQ(todo.id);
  ctx.maybeSettleHypothesisGroup(todo.id);
  ctx.appendSystem(
    `[${agent.id}] ✓ build commit landed for todo ${todo.id.slice(0, 8)} (${dirty.changedFiles} file change(s))`,
  );
  return "committed";
}

export function maybeSettleHypothesisGroup(
  ctx: WorkerContext,
  todoId: string,
): void {
  const t = ctx.getTodoQueue().get(todoId);
  if (!t || !t.groupId) return;
  const groupId = t.groupId;
  const settled = ctx.getTodoQueue().markGroupSettled(groupId, todoId);
  const ctrl = ctx.getHypothesisGroupAborts().get(groupId);
  if (ctrl) {
    ctrl.abort();
    ctx.getHypothesisGroupAborts().delete(groupId);
  }
  if (settled.skipped.length > 0) {
    ctx.appendSystem(
      `[T-Item-3] hypothesis group ${groupId} settled: winner=${todoId.slice(0, 8)}; cancelled ${settled.skipped.length} alternative(s) (${settled.skipped.map((id) => id.slice(0, 8)).join(", ")}).`,
    );
  } else {
    ctx.appendSystem(
      `[T-Item-3] hypothesis group ${groupId} settled: winner=${todoId.slice(0, 8)}; no other alternatives left to cancel.`,
    );
  }
}

export async function executeWorkerTodo(
  ctx: WorkerContext,
  agent: Agent,
  todo: Todo,
): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> {
  const modelAtEntry = agent.model;
  let commitTier: import("./types.js").CommitTier | undefined;
  let contents: Record<string, string | null>;
  try {
    // Read both expectedFiles AND contextFiles
    const allFiles = [
      ...todo.expectedFiles,
      ...(todo.contextFiles ?? []),
    ];
    contents = await ctx.readExpectedFiles(allFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.getWrappers().failTodoQ(todo.id, `[v2] read failure: ${msg}`);
    return "stale";
  }

  // Auto-anchor: when no anchors were declared but the file is large,
  // detect likely section names from the todo description and inject them
  // as anchors so windowFileWithAnchors shows the relevant region.
  let effectiveAnchors = todo.expectedAnchors;
  if (!effectiveAnchors || effectiveAnchors.length === 0) {
    const autoAnchors = autoDetectAnchors(todo.description, contents, todo.expectedFiles);
    if (autoAnchors.length > 0) {
      effectiveAnchors = autoAnchors;
      ctx.appendSystem(
        `[auto-anchor] Detected ${autoAnchors.length} anchor(s) from description: ${autoAnchors.join(", ")}`,
      );
    }
  }

  const budget = getModelBudget(agent.model);
  const activeCfg = ctx.getActive();
  const workerCwd = activeCfg?.localPath ?? agent.cwd;
  const webToolsEnabled = isWebToolsEnabled(activeCfg);
  const researchNotes = webToolsEnabled
    ? await runWorkerLiteratureResearch(ctx, agent, todo, workerCwd)
    : undefined;
  const promptExtras = resolveBlackboardPromptExtras({
    active: activeCfg,
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: agent.id,
  });
  let endpointCatalogBlock: string | undefined;
  if (todoTouchesApiSurface(todo.description, todo.expectedFiles)) {
    try {
      const catalogSnap = await loadEndpointCatalogSnapshot(workerCwd);
      if (catalogSnap) {
        endpointCatalogBlock = renderEndpointCatalogBlock(catalogSnap);
      }
    } catch {
      // best-effort
    }
  }

  const seed: WorkerSeed = {
    todoId: todo.id,
    description: todo.description,
    expectedFiles: todo.expectedFiles,
    contextFiles: todo.contextFiles,
    fileContents: contents,
    expectedAnchors: effectiveAnchors,
    roleGuidance: ctx.getWorkerRoles().get(agent.id),
    fullFileMode: budget.fullFileMode,
    directive: promptExtras.effectiveDirective ?? activeCfg?.userDirective,
    webToolsEnabled,
    ...(researchNotes ? { researchNotes } : {}),
    ...(promptExtras.userChatBlock ? { userChatBlock: promptExtras.userChatBlock } : {}),
    ...(endpointCatalogBlock ? { endpointCatalogBlock } : {}),
  };

  if (ctx.getActive()?.stigmergyOnBlackboard && pheromoneHeatmap.size > 0) {
    seed.hotFiles = pheromoneHeatmap.topFiles(10);
  }

  if (ctx.getActive()?.workerDispositions) {
    const cycle = ctx.getDispositionCycle();
    const turn = (cycle.get(agent.id) ?? 0) + 1;
    const disposition = getDispositionForTurn(turn);
    seed.disposition = disposition;
    cycle.set(agent.id, turn);
  }

  let response: string;
  try {
    response = await ctx.promptAgent(
      agent,
      `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`,
      workerToolProfile(ctx, "hunk"),
      "json",
      WORKER_HUNKS_JSON_SCHEMA,
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
  ctx.appendAgent(agent, response);

  let parsed = parseWorkerResponse(response, todo.expectedFiles);
  commitTier = "parse";  // assumed success tier — overridden below if parse fails
  if (!parsed.ok) {
    ctx.bumpJsonRepairs(agent.id);
    ctx.appendSystem(`[${agent.id}] [v2] worker JSON invalid (${parsed.reason}); issuing repair prompt.`);
    let repair: string;
    try {
      repair = await ctx.promptAgent(
        agent,
        `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
        workerToolProfile(ctx, "hunk"),
        "json",
        WORKER_HUNKS_JSON_SCHEMA,
      );
    } catch (err) {
      if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) return "aborted";
      const msg = err instanceof Error ? err.message : String(err);
      ctx.getWrappers().failTodoQ(todo.id, `[v2] worker repair prompt failed: ${msg}`, "repair");
      ctx.bumpPromptErrors(agent.id);
      ctx.bumpRejectedAttempts(agent.id);
      return "stale";
    }
    if (ctx.isStopping()) return "aborted";
    ctx.appendAgent(agent, repair);
    parsed = parseWorkerResponse(repair, todo.expectedFiles);
    if (parsed.ok) commitTier = "repair";
    if (!parsed.ok) {
      // Auditor interpretation: before sibling retry, let the auditor
      // try to interpret the response.
      const auditor = ctx.getAuditor();
      if (auditor && !ctx.isStopping()) {
        ctx.appendSystem(`[${agent.id}] [v2] parse failed after repair — routing raw response to auditor for JSON salvage.`);
        try {
          const salvage = await runParseSalvage(
            auditor,
            {
              getStopping: ctx.isStopping,
              appendSystem: ctx.appendSystem,
              appendAgent: (a, t, o) => ctx.appendAgent(a, t, o),
              promptPlannerSafely: (a, p, profile, schema) =>
                ctx.promptAgent(a, p, profile ?? workerToolProfile(ctx, "read"), "json", schema)
                  .then((r) => ({ response: r, agentUsed: a })),
              getActive: ctx.getActive,
              jsonSchema: WORKER_HUNKS_JSON_SCHEMA,
            },
            {
              kind: "worker",
              parseError: parsed.reason,
              rawOutput: repair || response,
              attempt: 1,
            },
          );
          const auditorResponse = salvage?.json ?? "";
          const auditorParsed = salvage
            ? parseWorkerResponse(auditorResponse, todo.expectedFiles)
            : { ok: false as const, reason: "auditor salvage failed" };
          if (auditorParsed.ok && (auditorParsed.hunks.length > 0 || auditorParsed.skip)) {
            parsed = auditorParsed;
            commitTier = "auditor-parse";
            ctx.appendSystem(
              auditorParsed.skip
                ? `[${agent.id}] [v2] auditor confirmed skip: ${auditorParsed.skip}`
                : `[${agent.id}] [v2] auditor interpreted response — ${auditorParsed.hunks.length} hunk(s).`,
            );
          }
        } catch (err) {
          ctx.appendSystem(`⚠ [${agent.id}] [v2] auditor interpretation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!parsed.ok) {
      let stopAborted = false;
      await withSiblingRetry(
        {
          agent,
          modelAtEntry,
          logPrefix: `[${agent.id}]`,
          updateAgentModel: ctx.updateAgentModel,
          emit: ctx.emit,
          getFallbackModel: ctx.getPlannerFallbackModel,
          reason: "sibling-retry: worker JSON parse failed after repair",
        },
        async () => {
          if (ctx.isStopping()) { stopAborted = true; return; }
          const siblingResponse = await ctx.promptAgent(
            agent,
            `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`,
            workerToolProfile(ctx, "hunk"),
            "json",
            WORKER_HUNKS_JSON_SCHEMA,
          );
          if (ctx.isStopping()) { stopAborted = true; return; }
          ctx.appendAgent(agent, siblingResponse);
          const siblingParsed = parseWorkerResponse(siblingResponse, todo.expectedFiles);
          if (siblingParsed.ok && siblingParsed.hunks.length > 0 && !siblingParsed.skip) {
            parsed = siblingParsed;
            commitTier = "sibling";
            ctx.appendSystem(`[${agent.id}] [v2] sibling-retry succeeded — ${siblingParsed.hunks.length} hunk(s) from ${agent.model}.`);
          }
        },
      );
      if (stopAborted) return "aborted";
    }
    if (!parsed.ok) {
      ctx.getWrappers().failTodoQ(todo.id, `[v2] worker produced invalid JSON after repair: ${parsed.reason}`, "repair");
      ctx.bumpRejectedAttempts(agent.id);
      return "stale";
    }
  }

  if (parsed.skip) {
    ctx.appendSystem(`[${agent.id}] [v2] worker declined todo: ${parsed.skip}`);
    const auditor = ctx.getAuditor();
    if (auditor) {
      const workerProfile = workerToolProfile(ctx, todo.kind === "build" ? "build" : "hunk");
      const fileContents = await ctx.readExpectedFiles(todo.expectedFiles);
      const verification = await verifyWorkerSkip(
        {
          todoDescription: todo.description,
          expectedFiles: todo.expectedFiles,
          skipReason: parsed.skip,
          workerIndex: agent.index,
          fileContents,
          criteriaCount: ctx.getActive()?.userDirective ? 1 : 0,
          workerToolProfile: workerProfile,
          workerTools: profileTools(workerProfile),
          todoKind: todo.kind,
        },
        ctx.promptAgent,
        auditor,
        resolveToolProfile("auditor", ctx.getActive()),
        ctx.appendAgent,
      );
      const findingPrefix = `[auditor] todo ${todo.id.slice(0, 8)} — worker-${agent.index} refused: "${parsed.skip}"`;

      if (verification.verdict === "invalid") {
        ctx.appendSystem(
          `Auditor overrode worker-${agent.index}'s refusal: ${verification.rationale}. ` +
          `Todo returns to board for another worker.`,
        );
        ctx.getWrappers().postFindingQ({
          agentId: auditor.id,
          text: `${findingPrefix} → INVALID refusal. ${verification.rationale}` +
            (verification.approachNotes ? ` Notes: ${verification.approachNotes}` : ""),
          createdAt: Date.now(),
        });
        if (verification.approachNotes) {
          ctx.appendSystem(`Auditor approach notes: ${verification.approachNotes}`);
        }
        ctx.getWrappers().releaseTodoQ(
          todo.id,
          `auditor overrode refusal: ${verification.rationale}`,
          verification.revisedDescription
            ? { description: verification.revisedDescription }
            : undefined,
        );
        ctx.recordInteraction("auditor_override_refusal", todo.id, auditor.id, verification.rationale);
        ctx.bumpRejectedAttempts(agent.id);
        return "released";
      }

      if (verification.verdict === "insufficient-tools") {
        const gap = verification.toolsetGap ?? "unknown capability";
        ctx.appendSystem(
          `SYSTEMIC TOOLSET GAP on todo ${todo.id.slice(0, 8)}: ${verification.rationale} ` +
          `(missing: ${gap}). Work cannot proceed with current worker profiles.`,
        );
        ctx.getWrappers().postFindingQ({
          agentId: auditor.id,
          text: `${findingPrefix} → INSUFFICIENT TOOLS (${gap}). ${verification.rationale}`,
          createdAt: Date.now(),
        });
        ctx.getWrappers().skipTodoQ(
          todo.id,
          `insufficient-tools: ${gap} — ${verification.rationale}`,
        );
        ctx.recordException("insufficient_tools", agent.id, todo.id, `${gap}: ${verification.rationale}`);
        ctx.recordInteraction("toolset_gap", todo.id, auditor.id, gap);
        return "skipped";
      }

      if (verification.verdict === "hallucinated-todo") {
        ctx.appendSystem(
          `Auditor: todo ${todo.id.slice(0, 8)} is a PLANNER HALLUCINATION — ${verification.rationale}. ` +
          `Routing to planner for discard/revise.`,
        );
        ctx.getWrappers().postFindingQ({
          agentId: auditor.id,
          text: `${findingPrefix} → HALLUCINATED TODO. ${verification.rationale}`,
          createdAt: Date.now(),
        });
        ctx.getWrappers().failTodoQ(
          todo.id,
          `auditor: planner hallucination — ${verification.rationale}`,
          "declined",
        );
        ctx.bumpRejectedAttempts(agent.id);
        ctx.recordInteraction("hallucinated_todo", todo.id, auditor.id, verification.rationale);
        return "stale";
      }

      if (verification.verdict === "valid" || verification.verdict === "unverified") {
        const label = verification.verdict === "valid" ? "VALID refusal" : "UNVERIFIED refusal";
        ctx.appendSystem(`Auditor: ${label} — ${verification.rationale}. Routing to planner.`);
        ctx.getWrappers().postFindingQ({
          agentId: auditor.id,
          text: `${findingPrefix} → ${label}. ${verification.rationale}`,
          createdAt: Date.now(),
        });
        ctx.getWrappers().failTodoQ(
          todo.id,
          `auditor: ${label.toLowerCase()} — ${verification.rationale} (worker: ${parsed.skip})`,
          "declined",
        );
        ctx.bumpRejectedAttempts(agent.id);
        ctx.recordException("worker_declined", agent.id, todo.id, parsed.skip);
        ctx.recordInteraction("worker_skip", todo.id, agent.id, parsed.skip);
        return "stale";
      }
    }

    ctx.getWrappers().failTodoQ(todo.id, `[v2] worker declined: ${parsed.skip}`, "declined");
    ctx.bumpRejectedAttempts(agent.id);
    ctx.recordException("worker_declined", agent.id, todo.id, parsed.skip);
    ctx.recordInteraction("worker_skip", todo.id, agent.id, parsed.skip);
    return "stale";
  }

  if (parsed.hunks.length === 0) {
    ctx.getWrappers().failTodoQ(todo.id, "[v2] worker returned empty hunks with no skip reason", "hunk-empty");
    ctx.bumpRejectedAttempts(agent.id);
    return "stale";
  }

  const k = ctx.getSelfConsistencyK();
  let hunksToCommit: readonly Hunk[] = parsed.hunks;
  if (k > 1) {
    const initialVotes: HunkVote[] = [{ workerId: `${agent.id}#1`, hunks: parsed.hunks }];
    const otherWorkers = ctx.getWorkerPool().filter((w) => w.id !== agent.id);
    const fanoutAgents: Agent[] = Array.from({ length: k - 1 }, (_, idx) => {
      if (otherWorkers.length === 0) return agent;
      return otherWorkers[idx % otherWorkers.length];
    });
    ctx.appendSystem(
      `[${agent.id}] [v2] self-consistency K=${k} fan-out across ${
        otherWorkers.length > 0
          ? `${new Set(fanoutAgents.map((a) => a.id)).size + 1} agents (${[agent.id, ...new Set(fanoutAgents.map((a) => a.id))].join(", ")})`
          : "1 agent (single-worker setup)"
      }`,
    );
    const extraPromises = Array.from({ length: k - 1 }, (_, idx) =>
      ctx.promptAgent(
        fanoutAgents[idx],
        `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`,
        workerToolProfile(ctx, "hunk"),
        "json",
        WORKER_HUNKS_JSON_SCHEMA,
      )
        .then((response) => ({ ok: true as const, idx: idx + 2, response, workerId: fanoutAgents[idx].id }))
        .catch((err) => ({ ok: false as const, idx: idx + 2, err, workerId: fanoutAgents[idx].id })),
    );
    const settled = await Promise.allSettled(extraPromises);
    if (ctx.isStopping()) return "aborted";
    for (const s of settled) {
      if (s.status === "rejected") continue;
      const r = s.value;
      if (!r.ok) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} prompt failed: ${
            r.err instanceof Error ? r.err.message : String(r.err)
          } — excluded from vote`,
        );
        continue;
      }
      const sourceAgent =
        ctx.getWorkerPool().find((w) => w.id === r.workerId) ?? agent;
      ctx.appendAgent(sourceAgent, r.response);
      const extraParsed = parseWorkerResponse(r.response, todo.expectedFiles);
      if (!extraParsed.ok) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} parse failed: ${extraParsed.reason} — excluded from vote`,
        );
        continue;
      }
      if (extraParsed.skip || extraParsed.hunks.length === 0) {
        ctx.appendSystem(
          `[${r.workerId}] [v2] self-consistency attempt ${r.idx}/${k} declined or empty — excluded from vote`,
        );
        continue;
      }
      initialVotes.push({ workerId: `${r.workerId}#${r.idx}`, hunks: extraParsed.hunks });
    }

    const judgeAgent = ctx.getAuditor() ?? agent;
    const judgeFn: JudgeFn = async (candidates) => {
      if (ctx.isStopping()) return null;
      const judgePrompt = buildJudgePrompt({
        todoDescription: todo.description,
        expectedFiles: todo.expectedFiles,
        candidates,
      });
      let judgeResponse: string;
      try {
        judgeResponse = await ctx.promptAgent(judgeAgent, judgePrompt, workerToolProfile(ctx, "read"), "json", {
          type: "object",
          properties: { winner: { type: "integer", minimum: 1, maximum: candidates.length } },
          required: ["winner"],
        });
        ctx.appendAgent(judgeAgent, judgeResponse);
      } catch (err) {
        ctx.appendSystem(
          `[${agent.id}] [v2] LLM-judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      try {
        const parsed = JSON.parse(judgeResponse);
        const winnerIdx = typeof parsed.winner === "number" ? parsed.winner : -1;
        if (winnerIdx < 1 || winnerIdx > candidates.length) return null;
        return candidates[winnerIdx - 1].id;
      } catch (err) {
        ctx.appendSystem(`⚠ worker [judge-parse]: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };

    const verdict = await voteOnHunksWithJudge(initialVotes, judgeFn);
    ctx.appendSystem(
      `[${agent.id}] [v2] self-consistency vote: ${verdict.agreementCount}/${verdict.totalConsidered} agreed` +
        ` · ${verdict.distinctShapes} distinct shape(s)` +
        ` · ${verdict.unanimous ? "unanimous" : verdict.hasMajority ? "majority" : `tiebreak=${verdict.tiebreak}`}`,
    );
    if (!verdict.winner) {
      ctx.getWrappers().failTodoQ(todo.id, "[v2] self-consistency: zero eligible votes after K attempts");
      ctx.bumpRejectedAttempts(agent.id);
      return "stale";
    }
    hunksToCommit = verdict.winner;
  }

  const clonePath = ctx.getActive()!.localPath;
  const fsAdapter = realFilesystemAdapter(clonePath);
  const gitAdapter = realGitAdapter(clonePath);
  const verifyCommand = ctx.getActive()?.verifyCommand?.trim();
  const verifyAdapter =
    verifyCommand && verifyCommand.length > 0
      ? realVerifyAdapter(clonePath, verifyCommand)
      : undefined;
  // Auditor-gated commits: store hunks for auditor review instead of
  // committing directly. The auditor will call applyAndCommit + completeTodoQ
  // after approving the changes.
  try {
    ctx.getWrappers().proposeCommitQ(todo.id, hunksToCommit as readonly unknown[], todo.expectedFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] proposeCommit failed: ${msg}`);
    ctx.getWrappers().failTodoQ(todo.id, `proposeCommit failed: ${msg}`, "hunk-fail");
    ctx.bumpRejectedAttempts(agent.id);
    return "stale";
  }
  ctx.appendSystem(
    `[${agent.id}] ✓ proposed ${hunksToCommit.length} hunk(s) for todo ${todo.id.slice(0, 8)} — awaiting auditor approval`,
  );
  return "pending-commit";
}