// Extracted from BlackboardRunner.ts — planner prompt + JSON parsing + repair +
// grounding + hypothesis grouping + sibling-retry fallback + V2 observer events +
// brain fallback (AI-assisted parsing when rule-based parsing fails).
// Takes a narrow PlannerContext object instead of referencing `this.*`.

import { randomUUID } from "node:crypto";
import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract } from "./types.js";
import type { PlannerSeed } from "./prompts/planner.js";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildRepairPrompt,
  parsePlannerResponse,
} from "./prompts/planner.js";
import { PLANNER_TODOS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { classifyExpectedFiles } from "./prompts/pathValidation.js";
import { checkExpectedSymbols } from "./runnerHelpers.js";
import { detectHypothesisTag } from "./hypothesisGrouping.js";
import { withSiblingRetry } from "./siblingRetry.js";
import {
  tryBrainFallback,
  type BrainFallbackEvent,
} from "./prompts/brainIntegration.js";
import { PlannerResponseSchema } from "./prompts/planner.js";

export interface PlannerContext {
  getContract: () => ExitContract | undefined;
  getActive: () => RunConfig | undefined;
  isStopping: () => boolean;
  getPlannerFallbackModel: () => string | undefined;
  updateAgentModel: (agentId: string, model: string) => void;
  emit: (e: unknown) => void;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  promptPlannerSafely: (
    agent: Agent,
    promptText: string,
    agentName?: "swarm" | "swarm-read" | "swarm-builder",
    ollamaFormat?: "json" | Record<string, unknown>,
  ) => Promise<{ response: string; agentUsed: Agent }>;
  /** Brain fallback: prompt an LLM to extract structured JSON from a
   *  failed parse. The promptFn signature matches promptWithFailover. */
  brainPromptFn?: (
    prompt: string,
    model: string,
    maxTokens: number,
    timeoutMs: number,
  ) => Promise<string>;
  wrappers: TodoQueueWrappers;
  findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  v2ObserverApply: (event: unknown) => void;
  hypothesisGroupAbortsSet: (groupId: string, controller: AbortController) => void;
  buildSeed: (clonePath: string, cfg: RunConfig) => Promise<PlannerSeed>;
  boardCounts: () => { open: number; claimed: number; stale: number; committed: number; skipped: number; total: number };
}

export async function runPlanner(
  ctx: PlannerContext,
  agent: Agent,
  seed: PlannerSeed,
  isFallbackAttempt = false,
): Promise<void> {
  const modelAtEntry = agent.model;

  const contractForPrompt = ctx.getContract()
    ? {
        missionStatement: ctx.getContract()!.missionStatement,
        criteria: ctx.getContract()!.criteria.map((c) => ({
          description: c.description,
          expectedFiles: c.expectedFiles,
        })),
      }
    : undefined;

  const { response: firstResponse, agentUsed: planAgent } = await ctx.promptPlannerSafely(
    agent,
    `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed, contractForPrompt)}`,
    "swarm-read",
    PLANNER_TODOS_JSON_SCHEMA,
  );
  if (ctx.isStopping()) return;
  ctx.appendAgent(planAgent, firstResponse);

  let parsed = parsePlannerResponse(firstResponse);
  if (!parsed.ok) {
    ctx.appendSystem(`Planner response did not parse (${parsed.reason}). Issuing repair prompt.`);
    const { response: repairResponse, agentUsed: repairAgent } = await ctx.promptPlannerSafely(
      planAgent,
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildRepairPrompt(firstResponse, parsed.reason)}`,
      "swarm-read",
      PLANNER_TODOS_JSON_SCHEMA,
    );
    if (ctx.isStopping()) return;
    ctx.appendAgent(repairAgent, repairResponse);
    parsed = parsePlannerResponse(repairResponse);
    if (!parsed.ok) {
      // Brain fallback: try AI-assisted parsing before sibling-retry.
      if (ctx.brainPromptFn) {
        ctx.appendSystem(`Planner parse still failed after repair — trying brain fallback (${parsed.reason}).`);
        const brainEvent = (e: BrainFallbackEvent) => {
          ctx.emit({ type: "brain-fallback", ...e });
        };
        try {
          const brainResult = await tryBrainFallback(
            firstResponse,
            PlannerResponseSchema,
            "planner",
            ctx.brainPromptFn,
            brainEvent,
          );
          if (brainResult) {
            const brainTodos = brainResult as unknown[];
            parsed = { ok: true as const, todos: brainTodos, dropped: [] };
            ctx.appendSystem(`Brain fallback succeeded — extracted ${brainTodos.length} todo(s).`);
          }
        } catch {
          // Brain call failed — fall through to sibling-retry.
        }
      }
    }
    if (!parsed.ok) {
      const retried = await withSiblingRetry(
        {
          agent,
          modelAtEntry,
          logPrefix: `[${agent.id}]`,
          updateAgentModel: ctx.updateAgentModel,
          emit: ctx.emit,
          getFallbackModel: ctx.getPlannerFallbackModel,
          reason: "sibling-retry: planner JSON parse failed after repair",
          isFallbackAttempt,
        },
        async () => {
          await runPlanner(ctx, agent, seed, true);
        },
      );
      if (retried) return;
      ctx.appendSystem(`Planner still invalid after repair (${parsed.reason}). Giving up this run.`);
      ctx.findingsPost({
        agentId: agent.id,
        text: `Planner failed to produce valid JSON after one repair attempt. Last error: ${parsed.reason}`,
        createdAt: Date.now(),
      });
      return;
    }
  }

  if (parsed.ok && !isFallbackAttempt && parsed.todos.length === 0) {
      const retried = await withSiblingRetry(
        {
          agent,
          modelAtEntry,
          logPrefix: `[${agent.id}]`,
          updateAgentModel: ctx.updateAgentModel,
          emit: ctx.emit,
          getFallbackModel: ctx.getPlannerFallbackModel,
          reason: `sibling-retry: planner produced only ${parsed.todos.length} todo(s)`,
          isFallbackAttempt,
        },
        async () => {
          await runPlanner(ctx, agent, seed, true);
        },
      );
      if (retried) return;
    }

  if (parsed.dropped.length > 0) {
    ctx.appendSystem(
      `Dropped ${parsed.dropped.length} invalid todo(s): ${parsed.dropped
        .map((d) => d.reason)
        .join(" | ")}`,
    );
  }

  const groundedTodos: typeof parsed.todos = [];
  let suspiciousStripped = 0;
  let todosDropped = 0;
  for (const t of parsed.todos) {
    const { accepted, rejected } = classifyExpectedFiles(t.expectedFiles, seed.repoFiles);
    for (const r of rejected) {
      suspiciousStripped += 1;
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": stripped suspicious path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    if (accepted.length === 0) {
      todosDropped += 1;
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped entirely — all ${t.expectedFiles.length} path(s) rejected by grounding check.`,
        createdAt: Date.now(),
      });
      continue;
    }
    groundedTodos.push({
      description: t.description,
      expectedFiles: accepted,
      expectedAnchors: t.expectedAnchors,
      expectedSymbols: t.expectedSymbols,
    });
  }
  if (suspiciousStripped > 0 || todosDropped > 0) {
    ctx.appendSystem(
      `Grounding check: stripped ${suspiciousStripped} suspicious path(s); dropped ${todosDropped} todo(s) that lost every path.`,
    );
  }

  const symbolGroundedTodos: typeof groundedTodos = [];
  let symbolDropped = 0;
  let symbolStripped = 0;
  for (const t of groundedTodos) {
    const result = await checkExpectedSymbols(t, seed.clonePath);
    if (!result.ok) {
      if (t.expectedSymbols && t.expectedSymbols.length > 0) {
        symbolStripped += 1;
        ctx.findingsPost({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": stripped hallucinated expectedSymbols (${result.missing.map((m) => `'${m.symbol}' in ${m.file}`).join(", ")}) — keeping todo with expectedFiles only.`,
          createdAt: Date.now(),
        });
        symbolGroundedTodos.push({
          description: t.description,
          expectedFiles: t.expectedFiles,
          expectedAnchors: t.expectedAnchors,
        });
      } else {
        symbolDropped += 1;
        ctx.findingsPost({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped by symbol-grounding — missing ${result.missing.map((m) => `'${m.symbol}' in ${m.file}`).join(", ")}.`,
          createdAt: Date.now(),
        });
      }
      continue;
    }
    symbolGroundedTodos.push(t);
  }
  if (symbolDropped > 0 || symbolStripped > 0) {
    const parts: string[] = [];
    if (symbolDropped > 0) parts.push(`dropped ${symbolDropped} todo(s)`);
    if (symbolStripped > 0) parts.push(`stripped hallucinated expectedSymbols from ${symbolStripped} todo(s)`);
    ctx.appendSystem(
      `Symbol-grounding check: ${parts.join("; ")}.`,
    );
  }
  groundedTodos.length = 0;
  groundedTodos.push(...symbolGroundedTodos);

  if (groundedTodos.length === 0) {
    const retried = await withSiblingRetry(
      {
        agent,
        modelAtEntry,
        logPrefix: `[${agent.id}]`,
        updateAgentModel: ctx.updateAgentModel,
        emit: ctx.emit,
        getFallbackModel: ctx.getPlannerFallbackModel,
        reason: "sibling-retry: planner produced 0 valid todos",
        isFallbackAttempt,
      },
      async () => {
        await runPlanner(ctx, agent, seed, true);
      },
    );
    if (retried) return;
    const dropDetail =
      parsed.dropped.length > 0 || todosDropped > 0
        ? `Planner returned only invalid/unbindable todos (${parsed.dropped.length} schema-dropped, ${todosDropped} grounding-dropped).`
        : "Planner returned an empty todo list — nothing actionable in the repo.";
    const fallbackNote = isFallbackAttempt
      ? " (sibling-model fallback also produced 0 todos)"
      : "";
    ctx.appendSystem(
      `⚠ Planner failed to produce actionable todos${fallbackNote}. ${dropDetail} The run will exit with stopReason="no-progress" after fallback reflection — no commits will land.`,
    );
    ctx.findingsPost({
      agentId: agent.id,
      text: dropDetail,
      createdAt: Date.now(),
    });
    return;
  }

  const now = Date.now();
  const cycleHypothesisGroupIds = new Map<string, string>();
  const active = ctx.getActive();
  if (active?.parallelHypothesisInFlight) {
    const hypothesisTodos = groundedTodos.filter(
      (t) => detectHypothesisTag(t.description) !== null,
    );
    if (hypothesisTodos.length > 0) {
      const allHaveCriteria = hypothesisTodos.every(
        (t) => Array.isArray(t.criteria) && t.criteria.length > 0,
      );
      if (allHaveCriteria) {
        const criterionToGroupId = new Map<string, string>();
        for (const t of hypothesisTodos) {
          const key = t.criteria![0];
          let gid = criterionToGroupId.get(key);
          if (!gid) {
            gid = `hyp-${randomUUID().slice(0, 8)}`;
            criterionToGroupId.set(key, gid);
            ctx.hypothesisGroupAbortsSet(gid, new AbortController());
          }
          cycleHypothesisGroupIds.set(t.description, gid);
        }
        ctx.appendSystem(
          `[T-Item-HypGrp per-criterion] ${hypothesisTodos.length} alternative(s) → ${criterionToGroupId.size} group(s) by criterion attribution.`,
        );
      } else {
        const cycleGroupId = `hyp-${randomUUID().slice(0, 8)}`;
        ctx.hypothesisGroupAbortsSet(cycleGroupId, new AbortController());
        for (const t of hypothesisTodos) {
          cycleHypothesisGroupIds.set(t.description, cycleGroupId);
        }
        ctx.appendSystem(
          `[T-Item-3 per-cycle hypothesis] detected ${hypothesisTodos.length} alternative(s) WITHOUT criteria attribution; falling back to one shared groupId=${cycleGroupId}.`,
        );
      }
    }
  }
  for (const t of groundedTodos) {
    const groupId = cycleHypothesisGroupIds.get(t.description);
    ctx.wrappers.postTodoQ({
      description: t.description,
      expectedFiles: t.expectedFiles,
      createdBy: agent.id,
      createdAt: now,
      expectedAnchors: t.expectedAnchors,
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.command ? { command: t.command } : {}),
      ...(t.preferredTag ? { preferredTag: t.preferredTag } : {}),
      ...(t.criteria && t.criteria.length > 0
        ? { criterionId: t.criteria[0], criteriaIds: t.criteria }
        : {}),
      ...(groupId ? { groupId } : {}),
    });
  }
  ctx.appendSystem(`Posted ${groundedTodos.length} todo(s) to the board.`);
  ctx.v2ObserverApply({
    type: "todos-posted",
    ts: now,
    count: groundedTodos.length,
  });
}

export async function runPlannerFallbackForUnmetCriteria(
  ctx: PlannerContext,
  planner: Agent,
): Promise<boolean> {
  const active = ctx.getActive();
  if (!active) return false;
  const openBefore = ctx.boardCounts().open;
  ctx.appendSystem(
    "Auditor produced no new work; trying a planner pass against the current contract before stopping.",
  );
  let seed: PlannerSeed;
  try {
    seed = await ctx.buildSeed(active.localPath, active);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`Planner-fallback seed build failed: ${msg}.`);
    return false;
  }
  if (ctx.isStopping()) return false;
  await runPlanner(ctx, planner, seed);
  if (ctx.isStopping()) return false;
  const openAfter = ctx.boardCounts().open;
  return openAfter > openBefore;
}