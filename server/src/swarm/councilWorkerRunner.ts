import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText } from "./councilUtils.js";
import { applyAndCommit } from "./blackboard/WorkerPipeline.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import {
  buildWorkerUserPrompt,
  buildWorkerRepairPrompt,
  buildHunkRepairPrompt,
  isRepairableApplyMiss,
  parseWorkerResponse,
  validateHunkPayload,
  WORKER_SYSTEM_PROMPT,
  isLiteratureTodo,
} from "./blackboard/prompts/worker.js";
import { mergeAnchorsForTodo } from "./grounding/mergeAnchors.js";
import { repairAndParseJson } from "./repairJson.js";
import { buildResearchToolsNote } from "./blackboard/prompts/planner.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import { isWebToolsEnabled, resolveCouncilToolProfile, resolveToolProfile } from "./toolProfiles.js";
import {
  effectiveToolProfileId,
  EMIT_ONLY_PROFILE_ID,
  EXPLORE_MAX_LITERATURE_TOOL_TURNS,
  LITERATURE_RESEARCH_NUDGE_MESSAGE,
  LITERATURE_RESEARCH_NUDGE_TURN,
  LITERATURE_RESEARCH_PROFILE,
  LITERATURE_RESEARCH_TOOLS,
  resolveMaxToolTurnsForProfile,
  type ToolProfileId,
} from "../../../shared/src/toolProfiles.js";
import { isUsableResearchBrief } from "./researchBrief.js";
import { localCatalogNotesOnResearchFail } from "./research/localCatalogIndex.js";
import {
  emitCouncilTodoClaimed,
  emitCouncilTodoCommitted,
  emitCouncilTodoFailed,
  emitCouncilTodoSkipped,
} from "./councilTodoWire.js";
import { makeBufferedToolHandler } from "./toolCallTranscript.js";
import { withSiblingRetry } from "./blackboard/siblingRetry.js";
import {
  councilWorkerFallbackModel,
  summarizeWorkerFailureReason,
} from "./councilWorkerFallback.js";
import { TodoQueue, type QueuedTodo } from "./blackboard/TodoQueue.js";
import { scoreCouncilTodoForDequeue } from "./councilTodoPlan.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { wrapProgressContextForPrompt } from "./councilProgressLedger.js";
import { noteRepairFailure, noteRepairSuccess } from "./applyIntegrityStats.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { checkBuildCommand } from "./blackboard/buildCommandAllowlist.js";
import simpleGit from "simple-git";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { SwarmEvent } from "../types.js";
import type { ToolResultHook } from "../tools/ToolDispatcher.js";

export type TodoSettledOutcome = "completed" | "skipped" | "failed";

export interface WorkerRunnerContext {
  appendSystem: (msg: string) => void;
  recordFailure?: (todoId: string, description: string, error: string) => void;
  onTodoSettled?: (info: {
    todoId: string;
    description: string;
    expectedFiles: readonly string[];
    outcome: TodoSettledOutcome;
    detail?: string;
  }) => void;
  /** Like onTodoSettled but includes the worker agent id (for cycle settlement). */
  onTodoSettledByAgent?: (
    agentId: string,
    info: {
      todoId: string;
      description: string;
      expectedFiles: readonly string[];
      outcome: TodoSettledOutcome;
      detail?: string;
    },
  ) => void;
  stopping: () => boolean;
  /** Soft drain: finish the in-flight todo, then exit without dequeuing more. */
  draining?: () => boolean;
  /** Aborted on hard stop so hung prompts fail fast. */
  promptSignal?: AbortSignal;
  /** Register per-worker AbortController so reaper can abort stuck todos. */
  registerTodoAbort?: (workerId: string, ctrl: AbortController) => void;
  unregisterTodoAbort?: (workerId: string) => void;
  getSwarmControl?: () => SwarmControlCenter;
  getCoachAgent?: () => Agent | undefined;
  emit?: (e: SwarmEvent) => void;
}

function wrapCouncilPromptWithControlHints(
  prompt: string,
  agentId: string,
  ctx: WorkerRunnerContext,
): string {
  const control = ctx.getSwarmControl?.();
  if (!control) return prompt;
  const agentHint = control.consumeAgentHint(agentId);
  const sessionHint = control.consumeSessionPlannerHint();
  const blocks: string[] = [];
  if (sessionHint) blocks.push(`[Swarm control — session]\n${sessionHint}`);
  if (agentHint) blocks.push(`[Swarm control — tool coach]\n${agentHint}`);
  if (blocks.length === 0) return prompt;
  return `${blocks.join("\n\n")}\n\n[End swarm control]\n\n${prompt}`;
}

function buildCouncilToolCoachHook(
  ctx: WorkerRunnerContext,
  agent: Agent,
  state: CouncilAdapterState,
): ToolResultHook | undefined {
  const control = ctx.getSwarmControl?.();
  const coach = ctx.getCoachAgent?.() ?? agent;
  if (!control) return undefined;
  return (info) => {
    if (info.ok) return;
    control.recordToolFailure(agent.id, info.tool, info.error ?? "tool error", info.preview, {
      agent: coach,
      clonePath: state.clonePath,
      runId: state.cfg.runId,
      manager: state.manager as any,
      appendSystem: ctx.appendSystem,
      emit: ctx.emit,
    });
  };
}

const WORKER_COOLDOWN_MS = 5_000;
const WORKER_DEFER_POLL_MS = 750;

/** Dequeue with file-scoped deferral: at most one in-flight writer per expectedFiles path. */
function dequeueCouncilTodo(queue: TodoQueue, workerId: string): QueuedTodo | null {
  const all = queue.list();
  const inProgress = all.filter((t) => t.status === "in-progress");
  const hasPendingOrActiveNonBuild = all.some(
    (t) => (t.status === "pending" || t.status === "in-progress") && t.kind !== "build",
  );

  let best: (typeof all)[number] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const t of all) {
    if (t.status !== "pending") continue;
    const score = scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore === Number.NEGATIVE_INFINITY) return null;
  return queue.dequeueByScore(workerId, (t) =>
    scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild),
  );
}

type TodoExecuteResult =
  | { outcome: "completed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

type WorkerRetryResult = { outcome: "retry"; reason: string; lastResponse?: string };
type WorkerAttemptResult = TodoExecuteResult | WorkerRetryResult;

function isWorkerRetry(r: WorkerAttemptResult): r is WorkerRetryResult {
  return r.outcome === "retry";
}

/** Consecutive literature failures before run-wide blackout. */
const LITERATURE_BLACKOUT_AFTER = 3;

async function runCouncilLiteratureResearch(
  state: CouncilAdapterState,
  agent: Agent,
  todo: QueuedTodo,
  appendSystem: (msg: string) => void,
  signal?: AbortSignal,
  opts?: { skip?: boolean },
): Promise<string | undefined> {
  if (opts?.skip || signal?.aborted) return undefined;
  const cfg = state.cfg;
  if (!isWebToolsEnabled(cfg) || !isLiteratureTodo(todo.description)) {
    return undefined;
  }

  // Per-todo cache: primary/repair/failover share one research pass (eee6718f).
  const cache = state.literatureNotesByTodoId ?? (state.literatureNotesByTodoId = new Map());
  if (cache.has(todo.id)) {
    const cached = cache.get(todo.id);
    return cached ?? undefined;
  }

  // Run-level blackout after repeated research tool failures.
  const blackout = state.researchBlackout ?? (state.researchBlackout = {
    consecutiveFailures: 0,
    active: false,
  });
  if (blackout.active) {
    appendSystem(
      `[${agent.id}] Literature research skipped (run blackout after ${blackout.consecutiveFailures} failures` +
        `${blackout.lastReason ? `: ${blackout.lastReason.slice(0, 80)}` : ""}) — using local tools only.`,
    );
    // Offline grounding: inject local endpoint catalog when web research is blacked out.
    const localNotes = localCatalogNotesOnResearchFail(todo.description, state.clonePath);
    if (localNotes) {
      appendSystem(
        `[${agent.id}] Local catalog: injected ${localNotes.length} chars of endpoint notes (blackout path).`,
      );
      cache.set(todo.id, localNotes);
      return localNotes;
    }
    cache.set(todo.id, null);
    return undefined;
  }

  (state.manager as {
    markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void;
  }).markStatus(agent.id, "thinking", {
    activityKind: "worker",
    activityLabel: "literature research",
    thinkingSince: Date.now(),
  });
  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    cfg.userDirective ? `User directive: ${cfg.userDirective}` : "",
    "",
    "Use web_search and web_fetch to gather citable findings. Output plain prose with bullet points and URLs.",
    "If search backends fail, stop tool use immediately and say so — do not retry the same query.",
    "Do NOT emit JSON hunks in this phase.",
  ].filter(Boolean).join("\n");

  try {
    // Literature is tool-heavy; keep budget tight so thrash fails fast.
    const litToolTurns = Math.min(EXPLORE_MAX_LITERATURE_TOOL_TURNS, 8);
    const res = await chatOnce(agent, {
      agentName: LITERATURE_RESEARCH_PROFILE,
      promptText: prompt,
      clonePath: state.clonePath,
      webToolsConfig: cfg,
      runId: cfg.runId,
      mcpServers: cfg.mcpServers,
      signal,
      manager: state.manager as any,
      activity: { kind: "worker", label: "literature research" },
      maxToolTurns: litToolTurns,
      toolsOverride: [...LITERATURE_RESEARCH_TOOLS],
      toolLoopNudge: {
        atTurn: Math.min(LITERATURE_RESEARCH_NUDGE_TURN, 4),
        message: LITERATURE_RESEARCH_NUDGE_MESSAGE,
      },
      onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
      // Shorter wall for literature — 120s idle was common on eee6718f.
      promptWallClockMs: 90_000,
    });
    const text = extractText(res)?.trim();
    if (text && isUsableResearchBrief(text)) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      appendSystem(`[${agent.id}] Literature research: captured ${capped.length} chars of notes.`);
      blackout.consecutiveFailures = 0;
      cache.set(todo.id, capped);
      return capped;
    }
    if (text && text.length >= 80) {
      appendSystem(
        `[${agent.id}] Literature research: rejected output (need prose notes with URLs, not JSON hunks or intent-only stubs).`,
      );
    }
    blackout.consecutiveFailures += 1;
    blackout.lastReason = "unusable brief";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
    blackout.consecutiveFailures += 1;
    blackout.lastReason = msg.slice(0, 160);
  }

  if (blackout.consecutiveFailures >= LITERATURE_BLACKOUT_AFTER) {
    blackout.active = true;
    appendSystem(
      `[research] Run-level literature blackout after ${blackout.consecutiveFailures} consecutive failures — ` +
        `further web research pre-passes skipped; workers use local read/grep only.`,
    );
  }

  // Hard search / unusable brief: fall back to local endpoint catalog (zero network).
  const localNotes = localCatalogNotesOnResearchFail(todo.description, state.clonePath);
  if (localNotes) {
    appendSystem(
      `[${agent.id}] Local catalog: injected ${localNotes.length} chars of endpoint notes (literature fail path).`,
    );
    cache.set(todo.id, localNotes);
    return localNotes;
  }

  cache.set(todo.id, null);
  return undefined;
}

function setWorkerThinking(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "thinking", { thinkingSince: Date.now() });
}

function setWorkerReady(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
}

export async function runCouncilWorkers(
  state: CouncilAdapterState,
  agents: Agent[],
  ctx: WorkerRunnerContext,
): Promise<{ completed: number; failed: number; skipped: number }> {
  if (agents.length === 0) return { completed: 0, failed: 0, skipped: 0 };

  const fsAdapter = realFilesystemAdapter(state.clonePath);
  const gitAdapter = realGitAdapter(state.clonePath);
  const results = await Promise.all(
    agents.map((agent) =>
      runCouncilWorker(state, agent, fsAdapter, gitAdapter, ctx),
    ),
  );

  return {
    completed: results.reduce((s, r) => s + r.completed, 0),
    failed: results.reduce((s, r) => s + r.failed, 0),
    skipped: results.reduce((s, r) => s + r.skipped, 0),
  };
}

async function runCouncilWorker(
  state: CouncilAdapterState,
  agent: Agent,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<{ completed: number; failed: number; skipped: number }> {
  let completed = 0, failed = 0, skipped = 0;

  while (!ctx.stopping()) {
    if (ctx.draining?.()) break;
    const todo = dequeueCouncilTodo(state.todoQueue, agent.id);
    if (todo) {
      emitCouncilTodoClaimed(state.emit, todo);
    }
    if (!todo) {
      if (state.todoQueue.counts().pending === 0) break;
      await new Promise((r) => setTimeout(r, WORKER_DEFER_POLL_MS));
      continue;
    }

    setWorkerThinking(state, agent);
    ctx.appendSystem(`[execution] ${agent.id} working on: ${todo.description.slice(0, 120)}...`);

    let result: TodoExecuteResult;
    try {
      result = await executeTodoWithRetryChain(agent, todo, state, fsAdapter, gitAdapter, ctx);
    } finally {
      setWorkerReady(state, agent);
    }
    if (result.outcome === "completed") {
      state.todoQueue.complete(todo.id);
      emitCouncilTodoCommitted(state.emit, todo.id);
      completed++;
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "completed" as const,
      };
      ctx.onTodoSettled?.(settled);
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      await new Promise((r) => setTimeout(r, WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500)));
    } else if (result.outcome === "skipped") {
      // Record agent before skip clears workerId.
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "skipped" as const,
        detail: result.reason,
      };
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      state.todoQueue.skip(todo.id, result.reason);
      emitCouncilTodoSkipped(state.emit, state.todoQueue, todo.id);
      skipped++;
      ctx.onTodoSettled?.(settled);
    } else {
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "failed" as const,
        detail: result.error,
      };
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      state.todoQueue.fail(todo.id, result.error);
      emitCouncilTodoFailed(state.emit, state.todoQueue, todo.id);
      failed++;
      ctx.recordFailure?.(todo.id, todo.description, result.error.slice(0, 200));
      ctx.onTodoSettled?.(settled);
    }
  }

  return { completed, failed, skipped };
}

async function executeCouncilBuildTodo(
  agent: Agent,
  todo: QueuedTodo,
  state: CouncilAdapterState,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<TodoExecuteResult> {
  const command = todo.command?.trim() ?? "";
  if (!command) {
    return { outcome: "failed", error: "build TODO missing command field" };
  }

  const check = checkBuildCommand(command);
  if (!check.ok) {
    return { outcome: "failed", error: `build command not allowed: ${check.reason}` };
  }

  ctx.appendSystem(
    `[execution] ${agent.id} running build command: \`${command}\` (binary: ${check.binary})`,
  );

  const buildPrompt = [
    "You are a build worker. Your job is to run ONE shell command via the bash tool.",
    "",
    `Command to run: ${command}`,
    `Working directory: ${state.clonePath}`,
    "",
    "Steps:",
    "1. Invoke the bash tool with the EXACT command above. Do not modify, prefix, or chain.",
    "2. After the command completes, respond with this JSON envelope and NOTHING ELSE:",
    `   {"ok": true|false, "exitCode": <number>, "summary": "<one-line summary of what changed>"}`,
    "",
    "If the command exits non-zero, set ok=false. Do not edit files manually — bash side effects are the entire delivery mechanism.",
  ].join("\n");

  try {
    const controller = new AbortController();
    const onPromptAbort = () => controller.abort(new Error("user stop"));
    ctx.promptSignal?.addEventListener("abort", onPromptAbort, { once: true });
    try {
      const profile = resolveToolProfile("worker-build", state.cfg);
      const res = await chatOnce(agent, {
        agentName: profile,
        promptText: buildPrompt,
        clonePath: state.clonePath,
        webToolsConfig: state.cfg,
        runId: state.cfg.runId,
        mcpServers: state.cfg.mcpServers,
        manager: state.manager as any,
        activity: { kind: "worker", label: "bash todo" },
        onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
      });
      const text = extractText(res)?.trim();
      if (text) {
        state.appendAgent(agent, text);
      }
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
    }

    const git = simpleGit(state.clonePath);
    const status = await git.status();
    const changedFiles =
      status.modified.length +
      status.created.length +
      status.deleted.length +
      status.renamed.length +
      status.not_added.length;

    if (changedFiles === 0) {
      return { outcome: "failed", error: "build command produced no file changes" };
    }

    const commitRes = await gitAdapter.commitAll(
      `build: ${todo.description.slice(0, 80)}`,
      agent.id,
    );
    if (!commitRes.ok) {
      return { outcome: "failed", error: commitRes.reason ?? "git commit failed" };
    }

    ctx.appendSystem(
      `[execution] ${agent.id} ✓ build commit landed — ${commitRes.sha?.slice(0, 7) ?? "ok"}.`,
    );
    return { outcome: "completed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
    return { outcome: "failed", error: `build prompt failed: ${msg.slice(0, 200)}` };
  }
}

async function executeTodoWithRetryChain(
  agent: Agent,
  todo: QueuedTodo,
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<TodoExecuteResult> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };

  if (todo.kind === "build" && todo.command) {
    return executeCouncilBuildTodo(agent, todo, state, gitAdapter, ctx);
  }

  const expectedFiles = [...todo.expectedFiles];

  // Stage 1: Primary prompt
  const primaryResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (!isWorkerRetry(primaryResult)) return primaryResult;
  const primaryReason = summarizeWorkerFailureReason(primaryResult.reason);

  // Stage 2: JSON repair prompt (same agent, echoes parse error + prior response)
  ctx.appendSystem(
    `[execution] ${agent.id} primary failed (${primaryReason}) — trying repair prompt.`,
  );
  const repairResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx, {
    repairFrom:
      primaryResult.lastResponse && primaryReason
        ? { previousResponse: primaryResult.lastResponse, parseError: primaryReason }
        : undefined,
  });
  if (!isWorkerRetry(repairResult)) return repairResult;
  const repairReason = summarizeWorkerFailureReason(repairResult.reason);

  // Stage 3: Failover model retry (providerFailover chain or SIBLING_MODELS)
  const modelAtEntry = agent.model;
  const fallbackModel = councilWorkerFallbackModel(modelAtEntry, state.cfg.providerFailover);
  if (!fallbackModel) {
    return {
      outcome: "failed",
      error: `all retries exhausted (last: ${repairReason}); no failover model in chain`,
    };
  }

  ctx.appendSystem(
    `[execution] ${agent.id} repair failed (${repairReason}) — trying failover model ${fallbackModel}.`,
  );
  let siblingResult: WorkerAttemptResult = { outcome: "retry", reason: repairReason };
  const didSwap = await withSiblingRetry(
    {
      agent,
      modelAtEntry,
      logPrefix: `[${agent.id}]`,
      updateAgentModel: (id, model) => {
        agent.model = model;
        (state.manager as { updateAgentModel?: (aid: string, m: string) => void }).updateAgentModel?.(
          id,
          model,
        );
      },
      emit: (ev) => { state.emit(ev); },
      getFallbackModel: () => fallbackModel,
      reason: "council-worker-failover: worker failed after repair",
    },
    async () => {
      siblingResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
    },
  );

  if (!didSwap) {
    return {
      outcome: "failed",
      error: `all retries exhausted (last: ${repairReason}); failover swap unavailable`,
    };
  }
  if (!isWorkerRetry(siblingResult)) return siblingResult;

  return {
    outcome: "failed",
    error: `all retries exhausted (last: ${summarizeWorkerFailureReason(siblingResult.reason)})`,
  };
}

function parseWorkerResponseWithRepair(raw: string, expectedFiles: string[]): ReturnType<typeof parseWorkerResponse> {
  const direct = parseWorkerResponse(raw, expectedFiles);
  if (direct.ok) return direct;
  const repaired = repairAndParseJson(raw);
  if (repaired?.value !== undefined && typeof repaired.value === "object" && repaired.value !== null) {
    const second = parseWorkerResponse(JSON.stringify(repaired.value), expectedFiles);
    if (second.ok) return second;
  }
  return direct;
}

async function tryWorkerPrompt(
  agent: Agent,
  todo: QueuedTodo,
  expectedFiles: string[],
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
  opts: {
    repairFrom?: { previousResponse: string; parseError: string };
  } = {},
): Promise<WorkerAttemptResult> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
  // Re-read file contents fresh each attempt (avoids stale content on retry)
  const fileContents = await readExpectedFiles(state.clonePath, expectedFiles);

  const allExist = expectedFiles.length > 0 && expectedFiles.every((f) => fileContents[f] !== null);
  let adjustedDesc = todo.description;
  if (allExist) {
    adjustedDesc = `${todo.description}\n\nIMPORTANT: The file(s) already exist. Use op "replace" or "append" — do NOT use op "create".`;
  }

  const webToolsEnabled = isWebToolsEnabled(state.cfg);
  // Literature only on primary attempt — repair/failover must not re-burn web tools.
  const researchNotes = await runCouncilLiteratureResearch(
    state,
    agent,
    todo,
    ctx.appendSystem,
    ctx.promptSignal,
    { skip: !!opts.repairFrom },
  );
  // Emit-biased profile: prefer JSON hunks over open-ended tool tours.
  // Read tools still available via a small turn cap when not pure emit.
  const workerProfile = effectiveToolProfileId("swarm-builder", state.cfg) as ToolProfileId;
  const defaultCap = resolveMaxToolTurnsForProfile(workerProfile);
  // eee6718f: workers with full tool budgets spent turns thinking/tooling and
  // never emitted JSON. Cap emit tools tightly; literature already ran.
  const workerToolTurnCap = Math.min(defaultCap ?? 0, 6);

  // RR-B: unified merge — planner expected ∪ description ∪ autoDetect.
  const expectedAnchors: string[] = mergeAnchorsForTodo({
    todoDescription: todo.description,
    expectedAnchors: todo.expectedAnchors ? [...todo.expectedAnchors] : undefined,
    fileContents,
    expectedFiles,
  });

  const progressBlock = wrapProgressContextForPrompt(state.progressContext ?? "");
  const userBlock = opts.repairFrom
    ? buildWorkerRepairPrompt(opts.repairFrom.previousResponse, opts.repairFrom.parseError)
    : buildWorkerUserPrompt({
        todoId: todo.id,
        description: adjustedDesc,
        expectedFiles,
        fileContents,
        expectedAnchors,
        directive: state.cfg.userDirective,
        webToolsEnabled,
        researchNotes,
      });
  const basePrompt = wrapCouncilPromptWithControlHints(
    `${WORKER_SYSTEM_PROMPT}\n\n${userBlock}${opts.repairFrom ? "" : progressBlock}`,
    agent.id,
    ctx,
  );
  const toolCoachHook = buildCouncilToolCoachHook(ctx, agent, state);

  try {
    const controller = new AbortController();
    const onPromptAbort = () => {
      try {
        controller.abort(ctx.promptSignal?.reason ?? new Error("user stop"));
      } catch {
        /* ignore */
      }
    };
    ctx.promptSignal?.addEventListener("abort", onPromptAbort, { once: true });
    ctx.registerTodoAbort?.(agent.id, controller);
    try {
    // formatExpect wired into stream guard (think-aware JSON sniff).
    // Prefer ollamaFormat json whenever tools are off; with a small tool
    // budget still request formatExpect so pure-think streams abort early.
    const raw = await promptWithFailoverAuto(agent, basePrompt, {
      manager: state.manager as any,
      agentName: workerProfile,
      signal: controller.signal,
      maxToolTurns: workerToolTurnCap,
      formatExpect: "json",
      ...(workerToolTurnCap === 0 ? { ollamaFormat: "json" as const } : {}),
      activity: { kind: "worker", label: `todo ${todo.id.slice(0, 8)}` },
      onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
      onToolResultHook: toolCoachHook,
      runId: state.cfg.runId,
      promptWallClockMs: 180_000,
    }, state.cfg.providerFailover);

    const res = extractProviderText(raw);
    if (res === null) {
      return { outcome: "retry", reason: "empty provider response", lastResponse: undefined };
    }

    // Mirror blackboard workerRunner: persist the model JSON so refresh/hydrate
    // can render WorkerHunksBubble (live StreamingDock alone is ephemeral).
    state.appendAgent(agent, res, { role: "worker" });

    const parsed = parseWorkerResponseWithRepair(res, expectedFiles);
    if (parsed.ok && parsed.hunks.length > 0 && !parsed.skip) {
      const sizeCheck = validateHunkPayload(parsed.hunks);
      if (!sizeCheck.ok) {
        return { outcome: "retry", reason: sizeCheck.reason, lastResponse: res };
      }
      // RR-A: never coerce create→replace with a 2KB prefix search (silent
      // half-file corruption). Prefer full-file write when create targets
      // an existing path; applyHunks still rejects bare create-on-existing.
      const fixedHunks = parsed.hunks.map((h) => {
        if ((h as any).op === "create" && fileContents[(h as any).file] !== null) {
          return {
            op: "write",
            file: (h as any).file,
            content: (h as any).content ?? "",
          } as any;
        }
        return h;
      });

      const applyResult = await applyAndCommit({
        todoId: todo.id,
        workerId: agent.id,
        expectedFiles,
        hunks: fixedHunks,
        fs: fsAdapter,
        git: gitAdapter,
        runId: state.cfg.runId,
      });

      if (applyResult.ok) {
        // Fail-closed: pipeline may still report ok with empty writes only if
        // policy changes; require real filesWritten before completing.
        if (!applyResult.filesWritten || applyResult.filesWritten.length === 0) {
          return {
            outcome: "retry",
            reason: "apply wrote zero files (no-op) — not a successful commit",
            lastResponse: res,
          };
        }
        ctx.appendSystem(`[execution] ${agent.id} ✓ applied — ${applyResult.commitSha?.slice(0, 7)}.`);
        return { outcome: "completed" };
      }

      // Apply failed — grounded hunk repair (search/start not found or not unique).
      // Never re-enter literature research on this pure apply-repair path.
      if (
        isRepairableApplyMiss({
          miss: applyResult.miss,
          reason: applyResult.reason,
        })
      ) {
        const miss = applyResult.miss;
        const failedFile =
          miss?.file ||
          applyResult.reason.match(/file "([^"]+)"/)?.[1] ||
          expectedFiles[0];
        // Always re-read from disk so repair is grounded on live content,
        // not the pre-prompt window snapshot.
        let currentContent: string | null = null;
        if (failedFile) {
          try {
            currentContent = await fsAdapter.read(failedFile);
          } catch {
            currentContent = null;
          }
          if (currentContent == null) {
            currentContent = fileContents[failedFile] ?? null;
          }
        }
        if (currentContent && fixedHunks.length > 0 && failedFile) {
          ctx.appendSystem(
            `[apply-miss] kind=${miss?.kind ?? "unknown"} file=${failedFile}` +
              (miss?.needle ? ` needle=${JSON.stringify(miss.needle).slice(0, 80)}` : "") +
              ` — grounded hunk repair (no literature)`,
          );
          const repairPrompt = buildHunkRepairPrompt(
            fixedHunks,
            applyResult.reason,
            { [failedFile]: currentContent },
            { miss },
          );
          // Emit-only profile ("swarm" → empty tools). maxToolTurns must be ≥1 so
          // OpenAI/Anthropic run a single model turn; Ollama no-tools path is single-shot.
          // Never use workerProfile here — tool-bearing + maxToolTurns:0 yields zero model turns.
          const repairRaw = await promptWithFailoverAuto(agent, wrapCouncilPromptWithControlHints(
            `${WORKER_SYSTEM_PROMPT}\n\n${repairPrompt}`,
            agent.id,
            ctx,
          ), {
            manager: state.manager as any,
            agentName: EMIT_ONLY_PROFILE_ID,
            signal: controller.signal,
            // Pure apply repair: tools-off profile + one model turn (no literature).
            maxToolTurns: 1,
            formatExpect: "json",
            ollamaFormat: "json" as const,
            onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
            onToolResultHook: toolCoachHook,
            runId: state.cfg.runId,
            activity: {
              kind: "worker",
              label: `repair ${todo.id.slice(0, 8)}`,
            },
          }, state.cfg.providerFailover);
          const repairText = extractProviderText(repairRaw);
          if (repairText) {
            state.appendAgent(agent, repairText, { role: "worker" });
            const repairParsed = parseWorkerResponse(repairText, expectedFiles);
            if (repairParsed.ok && repairParsed.hunks.length > 0 && !repairParsed.skip) {
              const repairResult = await applyAndCommit({
                todoId: todo.id,
                workerId: agent.id,
                expectedFiles,
                hunks: repairParsed.hunks,
                fs: fsAdapter,
                git: gitAdapter,
                runId: state.cfg.runId,
              });
              if (repairResult.ok) {
                if (!repairResult.filesWritten || repairResult.filesWritten.length === 0) {
                  noteRepairFailure(state.cfg.runId);
                  return {
                    outcome: "retry",
                    reason: "hunk repair wrote zero files (no-op) — not a successful commit",
                    lastResponse: repairText,
                  };
                }
                noteRepairSuccess(state.cfg.runId);
                ctx.appendSystem(`[execution] ${agent.id} ✓ applied (hunk repair) — ${repairResult.commitSha?.slice(0, 7)}.`);
                return { outcome: "completed" };
              }
              noteRepairFailure(state.cfg.runId);
            } else {
              noteRepairFailure(state.cfg.runId);
            }
          } else {
            noteRepairFailure(state.cfg.runId);
          }
        }
      }
      return {
        outcome: "retry",
        reason: applyResult.reason || "hunks could not be applied to the working tree",
        lastResponse: res,
      };
    }
    if (!parsed.ok) {
      return { outcome: "retry", reason: parsed.reason, lastResponse: res };
    }
    if (parsed.ok && parsed.skip) {
      ctx.appendSystem(`[execution] ${agent.id} skipped: ${parsed.skip}`);
      return { outcome: "skipped", reason: parsed.skip };
    }
    if (parsed.ok && parsed.hunks.length === 0) {
      return { outcome: "retry", reason: "worker returned no hunks", lastResponse: res };
    }

    return { outcome: "retry", reason: "worker response could not be committed", lastResponse: res };
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
      ctx.unregisterTodoAbort?.(agent.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
    if (/reaper:/i.test(msg)) {
      return { outcome: "failed", error: msg.slice(0, 200) };
    }
    const reason = summarizeWorkerFailureReason(msg);
    ctx.appendSystem(`[execution] ${agent.id} error: ${reason}`);
    return { outcome: "retry", reason: msg };
  }
}
