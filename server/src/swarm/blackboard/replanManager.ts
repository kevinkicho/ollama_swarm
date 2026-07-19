// Extracted from BlackboardRunner.ts — replan orchestration subsystem.
// Manages the stale-todo replan queue: enqueue, process, watcher tick, teardown.
// Takes a narrow context object instead of referencing `this.*`.

import type { Agent } from "../../services/AgentManager.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract, Todo } from "./types.js";
import {
  MAX_REPLAN_ATTEMPTS,
  REPLAN_FALLBACK_TICK_MS,
} from "./BlackboardRunnerConstants.js";
import {
  REPLANNER_SYSTEM_PROMPT,
  buildReplannerUserPrompt,
  buildReplannerFullPrompt,
  buildReplannerRepairFullPrompt,
  buildReplanPolicyGuidance,
  parseReplannerResponse,
  type ReplannerSeed,
} from "./prompts/replanner.js";
import {
  REPLANNER_JSON_SCHEMA,
} from "./prompts/jsonSchemas.js";
import { truncate } from "./truncate.js";

import { autoDetectAnchors } from "./autoAnchor.js";
import type { RunConfig } from "../SwarmRunner.js";
import { resolveToolProfile } from "../toolProfiles.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";
import { resolveMaxToolTurnsForPlanningPhase } from "@ollama-swarm/shared/toolProfiles";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import type { TranscriptEntry } from "../../types.js";
import type { AgentAssistKind } from "./runnerUtil.js";
import {
  resolveReplanPolicy,
  shouldTriggerBatchReplanBreaker,
} from "@ollama-swarm/shared/replanPolicy";
import { appendExplorationCache } from "@ollama-swarm/shared/explorationCache";
import type { ExplorationCacheEntry } from "@ollama-swarm/shared/explorationCache";
import { runReplannerEmitRecovery } from "./replannerRecovery.js";
import { applyPanelConvention } from "@ollama-swarm/shared/panelConvention";
import { evaluateReplannerSkip } from "@ollama-swarm/shared/swarmControl/replannerSkipGrounding";
import {
  todoLikelyNeedsTabInventory,
  buildTabInventories,
  renderTabInventoryBlock,
} from "./tabInventory.js";

export interface ReplanContext {
  getReplanPending: () => Set<string>;
  getReplanRunning: () => boolean;
  setReplanRunning: (v: boolean) => void;
  getPlanner: () => Agent | undefined;
  getAuditor: () => Agent | undefined;
  getActive: () => RunConfig | undefined;
  getContract?: () => ExitContract | undefined;
  getSessionPlannerHint?: () => string | undefined;
  getTranscript: () => readonly TranscriptEntry[];
  getAmendments?: () => Array<{ ts: number; text: string }>;
  getExplorationCache?: () => ExplorationCacheEntry[];
  setExplorationCache?: (cache: ExplorationCacheEntry[]) => void;
  getRepoFiles?: () => readonly string[];
  isStopping: () => boolean;
  isDraining: () => boolean;
  boardListTodos: () => Todo[];
  boardGetTodo: (id: string) => Todo | undefined;
  readExpectedFiles: (files: string[]) => Promise<Record<string, string | null>>;
  wrappers: TodoQueueWrappers;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: AgentAssistKind },
  ) => void;
  promptPlannerSafely: (
    agent: Agent,
    promptText: string,
    agentName?: ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: {
      kind?: string;
      label?: string;
      maxToolTurns?: number;
      mode?: "explore" | "emit";
    },
  ) => Promise<{ response: string; agentUsed: Agent }>;
  checkAndApplyCaps: () => boolean;
  emit?: (e: unknown) => void;
  recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => void;
  recordException: (type: string, agentId: string, todoId?: string, reason?: string) => void;
}

export function enqueueReplan(ctx: ReplanContext, todoId: string): void {
  if (ctx.getReplanPending().has(todoId)) return;
  ctx.getReplanPending().add(todoId);
  void processReplanQueue(ctx);
}

export async function processReplanQueue(ctx: ReplanContext): Promise<void> {
  if (ctx.getReplanRunning()) return;
  if (!ctx.getPlanner()) return;
  ctx.setReplanRunning(true);
  try {
    const batchBreaker = shouldTriggerBatchReplanBreaker(ctx.boardListTodos());
    if (batchBreaker) {
      ctx.appendSystem(
        "Batch replan breaker: ≥3 todos stale from worker timeout/tool-cap — forcing emit-first replans with prior explore cache.",
      );
    }
    while (!ctx.isStopping() && !ctx.isDraining() && ctx.getReplanPending().size > 0 && ctx.getPlanner()) {
      if (ctx.checkAndApplyCaps()) return;
      const todoId = ctx.getReplanPending().values().next().value as string;
      ctx.getReplanPending().delete(todoId);
      try {
        await replanOne(ctx, todoId, { batchBreaker });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Replan handler crashed on todo ${todoId}: ${msg}`);
        try {
          ctx.wrappers.skipTodoQ(todoId, `replanner crashed: ${msg}`);
        } catch (err) {
          ctx.appendSystem(`⚠ replan skip-todo: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } finally {
    ctx.setReplanRunning(false);
  }
}

function buildReplannerSeed(
  ctx: ReplanContext,
  todo: Todo,
  planner: Agent,
  contents: Record<string, string | null>,
  autoAnchors: string[] | undefined,
): ReplannerSeed {
  const promptExtras = resolveBlackboardPromptExtras({
    active: ctx.getActive(),
    getAmendments: ctx.getAmendments,
    transcript: ctx.getTranscript(),
    forAgentId: planner.id,
  });
  const explorationCache = ctx.getExplorationCache?.() ?? [];

  let tabInventoryBlock: string | undefined;
  if (todoLikelyNeedsTabInventory(todo.description, todo.expectedFiles)) {
    const inventories = buildTabInventories(contents, todo.expectedFiles);
    const block = renderTabInventoryBlock(inventories);
    if (block) tabInventoryBlock = block;
  }

  return {
    todoId: todo.id,
    originalDescription: todo.description,
    originalExpectedFiles: todo.expectedFiles,
    staleReason: todo.staleReason ?? "(unknown)",
    fileContents: contents,
    replanCount: todo.replanCount,
    autoAnchors,
    ...(explorationCache.length > 0 ? { explorationCache } : {}),
    ...(promptExtras.effectiveDirective ? { userDirective: promptExtras.effectiveDirective } : {}),
    ...(promptExtras.userChatBlock ? { userChatBlock: promptExtras.userChatBlock } : {}),
    ...(tabInventoryBlock ? { tabInventoryBlock } : {}),
  };
}

export async function replanOne(
  ctx: ReplanContext,
  todoId: string,
  opts?: { batchBreaker?: boolean },
): Promise<void> {
  const planner = ctx.getPlanner();
  if (!planner) return;
  const todo = ctx.boardListTodos().find((t) => t.id === todoId);
  if (!todo) return;
  if (todo.status !== "stale") return;

  // Fail-closed thrash: pure no-op / empty apply after one replan attempt is enough.
  // Exclude build-todo "command ran, tree clean" when the command itself failed
  // (ECONNREFUSED, exit≠0) — that is environment failure, not apply thrash
  // (a12daea8 / 3d0aceba t8 permanent:noop-exhausted after regress ECONNREFUSED).
  const staleText = `${todo.staleReason ?? ""} ${(todo as { reason?: string }).reason ?? ""}`;
  const isBuildEnvFail =
    todo.kind === "build"
    || /build command|test:regress|test:validate|ECONNREFUSED|exit(?:ed)?\s*(?:code\s*)?[1-9]/i.test(
      staleText,
    );
  const isNoopStale =
    !isBuildEnvFail
    && /no file changes|no-op elided|wrote zero files|zero files \(no-op\)|hunk-empty|empty hunks/i.test(
      staleText,
    );
  const replanCap = isNoopStale ? 1 : MAX_REPLAN_ATTEMPTS;
  if (todo.replanCount >= replanCap) {
    ctx.wrappers.skipTodoQ(
      todoId,
      isNoopStale
        ? `permanent:noop-exhausted: replan after no-op apply (${todo.replanCount})`
        : `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
    );
    ctx.appendSystem(
      isNoopStale
        ? `Permanent-skipped todo ${todoId} after no-op apply thrash.`
        : `Replan exhausted for todo ${todoId} after ${todo.replanCount} attempt(s). Skipped.`,
    );
    return;
  }

  let contents: Record<string, string | null>;
  try {
    contents = await ctx.readExpectedFiles(todo.expectedFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.wrappers.skipTodoQ(todoId, `replanner unable to read files: ${msg}`);
    return;
  }

  let autoAnchors: string[] | undefined;
  if (!todo.expectedAnchors || todo.expectedAnchors.length === 0) {
    autoAnchors = autoDetectAnchors(todo.description, contents, todo.expectedFiles);
    if (autoAnchors.length > 0) {
      ctx.appendSystem(
        `[auto-anchor] Detected ${autoAnchors.length} anchor(s) from description: ${autoAnchors.join(", ")}`,
      );
    }
  }

  const seed = buildReplannerSeed(ctx, todo, planner, contents, autoAnchors);
  const explorationCache = ctx.getExplorationCache?.() ?? [];
  const hasCache = explorationCache.some((e) => e.excerpt.trim().length > 0);
  const batchBreaker = opts?.batchBreaker === true;
  const policy = resolveReplanPolicy(todo.staleReason, {
    batchBreaker,
    hasExplorationCache: hasCache,
  });

  const exploreProfile = resolveToolProfile("planner", ctx.getActive());
  const emitProfile = EMIT_ONLY_PROFILE_ID;
  const policyGuidance = buildReplanPolicyGuidance(policy);

  const recovery = await runReplannerEmitRecovery({
    agent: planner,
    auditor: ctx.getAuditor(),
    policy,
    getStopping: ctx.isStopping,
    appendSystem: ctx.appendSystem,
    appendAgent: ctx.appendAgent,
    emitActivity: (label, attempt, maxAttempts, mode) => {
      void label;
      void attempt;
      void maxAttempts;
      void mode;
    },
    promptPlannerSafely: (a, p, profile, schema, activity) =>
      ctx.promptPlannerSafely(a, p, profile, schema, {
        ...activity,
        maxToolTurns:
          activity?.mode === "emit"
            ? 0
            : activity?.maxToolTurns
              ?? resolveMaxToolTurnsForPlanningPhase("replan", ctx.getActive()),
      }),
    buildPrimaryPrompt: () => {
      const sessionHint = ctx.getSessionPlannerHint?.();
      const hintBlock = sessionHint
        ? `[Swarm control hint]\n${sessionHint}\n[End swarm control hint]\n\n`
        : "";
      const base = policyGuidance
        ? `${REPLANNER_SYSTEM_PROMPT}\n\n${policyGuidance}\n${buildReplannerUserPrompt(seed)}`
        : buildReplannerFullPrompt(seed);
      return hintBlock + base;
    },
    buildRepairPrompt: (prev, err) => buildReplannerRepairFullPrompt(seed, prev, err),
    exploreProfile: policy.emitFirst && !policy.allowExplore ? emitProfile : exploreProfile,
    emitProfile,
    parse: (raw) => {
      const p = parseReplannerResponse(raw);
      if (p.ok) return { ok: true as const, value: p, raw };
      return { ok: false as const, reason: p.reason, raw };
    },
    getActive: ctx.getActive,
    onExploreCaptured: (raw) => {
      if (!ctx.setExplorationCache) return;
      const next = appendExplorationCache(explorationCache, {
        phase: "replan",
        excerpt: raw,
        agentId: planner.id,
      });
      ctx.setExplorationCache(next);
    },
  });

  if (!recovery.ok) {
    ctx.wrappers.skipTodoQ(
      todoId,
      `replanner failed after recovery: ${recovery.reason}`,
    );
    return;
  }
  if (ctx.isStopping()) return;

  let parsed = recovery.value;

  const repoFiles = ctx.getRepoFiles?.() ?? [];
  if (parsed.action === "revised" && repoFiles.length > 0) {
    const convention = applyPanelConvention(
      { description: parsed.description, expectedFiles: parsed.expectedFiles },
      repoFiles,
    );
    if (convention.action === "repath" || convention.action === "register-existing") {
      parsed = {
        ...parsed,
        description: convention.description,
        expectedFiles: convention.expectedFiles,
      };
      ctx.appendSystem(`Replanner panel convention for ${todoId}: ${convention.note}`);
    } else if (convention.action === "skip") {
      ctx.wrappers.skipTodoQ(todoId, `replanner panel dedup: ${convention.reason}`);
      ctx.appendSystem(`Replanner skipped todo ${todoId} (panel dedup): ${convention.reason}`);
      return;
    }
  }

  if (parsed.action === "skip") {
    const unmet =
      ctx.getContract?.()?.criteria.filter((c) => c.status === "unmet").length ?? 0;
    const grounding = evaluateReplannerSkip({
      reason: parsed.reason,
      expectedFiles: todo.expectedFiles,
      fileContents: contents,
      unmetCriteriaCount: unmet,
    });
    if (!grounding.allow) {
      ctx.appendSystem(
        `Replanner skip blocked for ${todoId} (control grounding): ${grounding.blockReason}. Forcing revise.`,
      );
      try {
        ctx.wrappers.resetTodoQ(todoId, {
          description: `${todo.description} — revise: ${grounding.blockReason}`,
          expectedFiles: todo.expectedFiles,
          expectedAnchors: todo.expectedAnchors,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.wrappers.skipTodoQ(todoId, `replanner skip blocked; reset failed: ${msg}`);
      }
      return;
    }
    ctx.wrappers.skipTodoQ(todoId, `replanner decided to skip: ${parsed.reason}`);
    ctx.appendSystem(`Replanner skipped todo ${todoId}: ${parsed.reason}`);
    ctx.recordInteraction("replanner_skip", todoId, planner.id, parsed.reason);
    ctx.recordException("replanner_skip", planner.id, todoId, parsed.reason);
    return;
  }

  try {
    ctx.wrappers.resetTodoQ(todoId, {
      description: parsed.description,
      expectedFiles: parsed.expectedFiles,
      expectedAnchors: parsed.expectedAnchors,
      ...(parsed.kind ? { kind: parsed.kind } : {}),
      ...(parsed.command ? { command: parsed.command } : {}),
      ...(parsed.contextFiles ? { contextFiles: parsed.contextFiles } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`Replan refused for todo ${todoId}: ${msg}`);
    return;
  }
  const updated = ctx.boardGetTodo(todoId);
  ctx.appendSystem(
    `Replanned todo ${todoId} (attempt ${updated?.replanCount ?? 0}): "${truncate(updated?.description ?? parsed.description)}"`,
  );
  ctx.recordInteraction("replanner_revise", todoId, planner.id, parsed.description);
}

export function startReplanWatcher(ctx: ReplanContext): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (ctx.isStopping()) return;
    try {
      for (const todo of ctx.boardListTodos()) {
        if (todo.status === "stale" && todo.replanCount < MAX_REPLAN_ATTEMPTS) {
          enqueueReplan(ctx, todo.id);
        }
      }
      for (const todo of ctx.boardListTodos()) {
        if (todo.status === "stale" && todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
          ctx.wrappers.skipTodoQ(
            todo.id,
            `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Replan tick failed: ${msg}`);
    }
  }, REPLAN_FALLBACK_TICK_MS);
  timer.unref?.();
  return timer;
}

export function stopReplanWatcher(timer: NodeJS.Timeout | undefined): void {
  if (timer) clearInterval(timer);
}