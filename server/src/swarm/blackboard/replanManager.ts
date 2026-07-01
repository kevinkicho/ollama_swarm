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
  buildReplannerRepairPrompt,
  parseReplannerResponse,
  type ReplannerSeed,
  ReplannerResponseSchema,
} from "./prompts/replanner.js";
import {
  REPLANNER_JSON_SCHEMA,
} from "./prompts/jsonSchemas.js";
import { truncate } from "./truncate.js";
import {
  tryBrainFallback,
  type BrainFallbackEvent,
} from "./prompts/brainIntegration.js";
import { autoDetectAnchors } from "./autoAnchor.js";

export interface ReplanContext {
  getReplanPending: () => Set<string>;
  getReplanRunning: () => boolean;
  setReplanRunning: (v: boolean) => void;
  getPlanner: () => Agent | undefined;
  isStopping: () => boolean;
  boardListTodos: () => Todo[];
  boardGetTodo: (id: string) => Todo | undefined;
  readExpectedFiles: (files: string[]) => Promise<Record<string, string | null>>;
  wrappers: TodoQueueWrappers;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  promptPlannerSafely: (agent: Agent, promptText: string, agentName?: "swarm" | "swarm-read" | "swarm-builder", ollamaFormat?: "json" | Record<string, unknown>) => Promise<{ response: string; agentUsed: Agent }>;
  checkAndApplyCaps: () => boolean;
  emit?: (e: unknown) => void;
  // Plan 4: brain system overseer
  recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => void;
  recordException: (type: string, agentId: string, todoId?: string, reason?: string) => void;
  /** Brain fallback: prompt an LLM to extract structured JSON from a
   *  failed parse. The promptFn signature matches promptWithFailover. */
  brainPromptFn?: (
    prompt: string,
    model: string,
    maxTokens: number,
    timeoutMs: number,
  ) => Promise<string>;
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
    while (!ctx.isStopping() && ctx.getReplanPending().size > 0 && ctx.getPlanner()) {
      if (ctx.checkAndApplyCaps()) return;
      const todoId = ctx.getReplanPending().values().next().value as string;
      ctx.getReplanPending().delete(todoId);
      try {
        await replanOne(ctx, todoId);
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

export async function replanOne(ctx: ReplanContext, todoId: string): Promise<void> {
  const planner = ctx.getPlanner();
  if (!planner) return;
  const todo = ctx.boardListTodos().find((t) => t.id === todoId);
  if (!todo) return;
  if (todo.status !== "stale") return;

  if (todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
    ctx.wrappers.skipTodoQ(
      todoId,
      `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
    );
    ctx.appendSystem(
      `Replan exhausted for todo ${todoId} after ${todo.replanCount} attempt(s). Skipped.`,
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

  // Auto-anchor: when no anchors were declared but the file is large,
  // detect likely section names from the todo description and inject them
  // as anchors so windowFileWithAnchors shows the relevant region.
  let autoAnchors: string[] | undefined;
  if (!todo.expectedAnchors || todo.expectedAnchors.length === 0) {
    autoAnchors = autoDetectAnchors(todo.description, contents, todo.expectedFiles);
    if (autoAnchors.length > 0) {
      ctx.appendSystem(
        `[auto-anchor] Detected ${autoAnchors.length} anchor(s) from description: ${autoAnchors.join(", ")}`,
      );
    }
  }

  const seed: ReplannerSeed = {
    todoId: todo.id,
    originalDescription: todo.description,
    originalExpectedFiles: todo.expectedFiles,
    staleReason: todo.staleReason ?? "(unknown)",
    fileContents: contents,
    replanCount: todo.replanCount,
    autoAnchors,
  };

  let response: string;
  let replanAgent: Agent;
  try {
    const r = await ctx.promptPlannerSafely(
      planner,
      `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerUserPrompt(seed)}`,
      undefined,
      REPLANNER_JSON_SCHEMA,
    );
    response = r.response;
    replanAgent = r.agentUsed;
  } catch (err) {
    if (ctx.isStopping()) return;
    const msg = err instanceof Error ? err.message : String(err);
    ctx.wrappers.skipTodoQ(todoId, `replanner prompt failed: ${msg}`);
    return;
  }
  if (ctx.isStopping()) return;
  ctx.appendAgent(replanAgent, response);

  let parsed = parseReplannerResponse(response);
  if (!parsed.ok) {
    ctx.appendSystem(
      `Replanner JSON invalid for ${todoId} (${parsed.reason}); issuing repair prompt.`,
    );
    let repair: string;
    let repairAgent: Agent;
    try {
      const r = await ctx.promptPlannerSafely(
        replanAgent,
        `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerRepairPrompt(response, parsed.reason)}`,
        undefined,
        REPLANNER_JSON_SCHEMA,
      );
      repair = r.response;
      repairAgent = r.agentUsed;
    } catch (err) {
      if (ctx.isStopping()) return;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.wrappers.skipTodoQ(todoId, `replanner repair prompt failed: ${msg}`);
      return;
    }
    if (ctx.isStopping()) return;
    ctx.appendAgent(repairAgent, repair);
    parsed = parseReplannerResponse(repair);
    if (!parsed.ok) {
      // Brain fallback: try AI-assisted parsing before giving up.
      if (ctx.brainPromptFn) {
        ctx.appendSystem(`Replanner parse still failed after repair — trying brain fallback (${parsed.reason}).`);
        try {
          const brainResult = await tryBrainFallback(
            "replanner",
            response,
            ReplannerResponseSchema,
            ctx.brainPromptFn,
            (e: BrainFallbackEvent) => { ctx.emit?.({ type: "brain-fallback", ...e }); },
            planner,
          );
          if (brainResult) {
            parsed = brainResult as unknown as typeof parsed;
            ctx.appendSystem(`Brain fallback succeeded — extracted replanner result.`);
          }
        } catch (err) {
          ctx.appendSystem(`⚠ replan brain-fallback: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!parsed.ok) {
      ctx.wrappers.skipTodoQ(
        todoId,
        `replanner produced invalid JSON after repair: ${parsed.reason}`,
      );
      return;
    }
  }

  if (parsed.action === "skip") {
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