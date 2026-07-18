// Extracted from BlackboardRunner.ts — planner prompt + JSON parsing + repair +
// grounding + hypothesis grouping + sibling-retry fallback + V2 observer events +
// planner recovery loop (no in-run brain parse fallback).
// Takes a narrow PlannerContext object instead of referencing `this.*`.

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract } from "./types.js";
import type { PlannerSeed } from "./prompts/planner.js";
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildRepairPrompt,
  parsePlannerResponse,
  salvagePlannerTodosFromDropped,
  extractFileMentions,
} from "./prompts/planner.js";
import { PLANNER_TODOS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { classifyPath } from "./prompts/pathValidation.js";
import { groundExpectedFiles } from "./contractGrounding.js";
import { checkExpectedSymbols } from "./runnerHelpers.js";
import { detectHypothesisTag } from "./hypothesisGrouping.js";
import { withSiblingRetry } from "./siblingRetry.js";
import { runPlannerEmitRecovery } from "./plannerRecovery.js";
import { emitAgentActivity } from "./promptRunner.js";
import { detectTodoBatchFileOverlaps } from "./workerFileConflict.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";
import { resolveToolProfile } from "../toolProfiles.js";
import { resolveMaxToolTurnsForPlanningPhase } from "@ollama-swarm/shared/toolProfiles";
import {
  appendExplorationCache,
  getExplorationExcerpt,
  shouldSkipTodosExplore,
} from "@ollama-swarm/shared/explorationCache";
import { isSeedSufficientForDirectEmit } from "@ollama-swarm/shared/planningSeed";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { applyPanelConventionToTodos } from "./plannerPanelGrounding.js";

/**
 * Last-resort micro-todos when the planner schema-dropped everything.
 * Prefer unmet contract criteria with grounded expectedFiles; else sample
 * top-level HTML/src files for a concrete edit-shaped task.
 */
export function buildEmergencyPlannerTodos(
  seed: PlannerSeed,
  contract?: ExitContract | null,
): Array<{
  description: string;
  expectedFiles: string[];
  expectedAnchors?: string[];
  expectedSymbols?: string[];
}> {
  const out: Array<{
    description: string;
    expectedFiles: string[];
    expectedAnchors?: string[];
    expectedSymbols?: string[];
  }> = [];
  const seen = new Set<string>();

  if (contract?.criteria?.length) {
    for (const c of contract.criteria) {
      if (c.status === "met" || c.status === "wont-do") continue;
      const files = (c.expectedFiles ?? []).filter(Boolean).slice(0, 2);
      if (files.length === 0) continue;
      const { grounded } = groundExpectedFiles(files, seed.repoFiles);
      if (grounded.length === 0) continue;
      const key = grounded.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const desc =
        (c.description || c.id || "Address unmet criterion")
          .toString()
          .trim()
          .slice(0, 480);
      out.push({
        description: `Emergency board seed: ${desc}`,
        expectedFiles: grounded,
      });
      if (out.length >= 3) return out;
    }
  }

  // No useful criteria — pick a few real repo files (prefer modules/html/src).
  const scored = seed.repoFiles
    .filter((f) => !f.includes("node_modules") && !f.startsWith("."))
    .map((f) => {
      let score = 0;
      if (/\.html?$/i.test(f)) score += 5;
      if (/\.(tsx?|jsx?|mjs)$/i.test(f)) score += 3;
      if (/^\d+_/.test(f.split("/").pop() ?? "")) score += 2;
      if (f.split("/").length === 1) score += 1;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { f } of scored) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push({
      description:
        `Emergency board seed: improve or expand educational content in ${f} ` +
        `(concrete file edit; no research-only work)`,
      expectedFiles: [f],
    });
    if (out.length >= 3) break;
  }

  // Directive may name files even when contract is empty
  if (out.length === 0 && seed.userDirective) {
    const mentions = extractFileMentions(seed.userDirective);
    for (const m of mentions.slice(0, 3)) {
      const { grounded } = groundExpectedFiles([m], seed.repoFiles);
      if (grounded.length === 0) continue;
      out.push({
        description: `Emergency board seed: address user directive in ${grounded[0]}`,
        expectedFiles: grounded.slice(0, 2),
      });
      if (out.length >= 2) break;
    }
  }

  return out;
}

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
    agentName?: ProfileName,
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: { kind?: string; label?: string; maxToolTurns?: number },
  ) => Promise<{ response: string; agentUsed: Agent }>;
  wrappers: TodoQueueWrappers;
  findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => void;
  getAuditor: () => Agent | undefined;
  emitAgentState: (s: import("../../types.js").AgentState) => void;
  manager: AgentManager;
  v2ObserverApply: (event: unknown) => void;
  hypothesisGroupAbortsSet: (groupId: string, controller: AbortController) => void;
  buildSeed: (clonePath: string, cfg: RunConfig) => Promise<PlannerSeed>;
  boardCounts: () => { open: number; claimed: number; stale: number; committed: number; skipped: number; total: number };
  noteProviderStall?: (msg: string) => void;
  getSessionPlannerHint?: () => string | undefined;
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

  const plannerProfile = resolveToolProfile("planner", ctx.getActive());
  const exploreProfile = plannerProfile;
  const emitProfile = EMIT_ONLY_PROFILE_ID;
  const exploreToolCap = resolveMaxToolTurnsForPlanningPhase(
    "planner-todos-explore",
    ctx.getActive(),
  );
  const cachedExplore =
    shouldSkipTodosExplore(seed.explorationCache)
      ? getExplorationExcerpt(seed.explorationCache, "contract-explore")
        ?? getExplorationExcerpt(seed.explorationCache, "council-shared-explore")
      : undefined;
  const emitDirectFromSeed =
    !cachedExplore && isSeedSufficientForDirectEmit(seed, ctx.getActive());
  if (cachedExplore) {
    ctx.appendSystem(
      "Planner todos: reusing contract explore brief — skipping redundant repo tour.",
    );
  } else if (emitDirectFromSeed) {
    ctx.appendSystem(
      "Planner todos: seed-direct emit — rich grounding present, skipping explore turn.",
    );
  }

  const explorePromptSeed = `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed, contractForPrompt, agent.model)}`;
  const recovery = await runPlannerEmitRecovery({
    kind: "planner-todos",
    agent,
    auditor: ctx.getAuditor(),
    getStopping: ctx.isStopping,
    appendSystem: ctx.appendSystem,
    appendAgent: ctx.appendAgent,
    findingsPost: ctx.findingsPost,
    getActive: ctx.getActive,
    clonePath: ctx.getActive()?.localPath,
    promptExcerpt: explorePromptSeed.slice(0, 1500),
    emitActivity: (label, attempt, maxAttempts, mode) => {
      emitAgentActivity(agent, ctx.manager, ctx.emitAgentState, {
        kind: "planner-todos",
        label,
        attempt,
        maxAttempts,
        mode,
      });
    },
    promptPlannerSafely: (a, p, profile, schema, activity) =>
      ctx.promptPlannerSafely(a, p, profile, schema, {
        ...activity,
        maxToolTurns:
          schema || profile === emitProfile
            ? 0
            : profile === exploreProfile
              ? exploreToolCap
              : undefined,
      }),
    buildExplorePrompt: () => explorePromptSeed,
    buildRepairPrompt: (prev, err, note) =>
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildRepairPrompt(prev, err, note)}`,
    exploreProfile,
    emitProfile,
    jsonSchema: PLANNER_TODOS_JSON_SCHEMA,
    parse: (raw) => {
      const p = parsePlannerResponse(raw);
      if (p.ok) return { ok: true as const, value: p.todos, raw, dropped: p.dropped };
      return { ok: false as const, reason: p.reason, raw };
    },
    cachedExploreResponse: cachedExplore,
    emitDirectFromSeed,
    onExploreCaptured: (raw) => {
      seed.explorationCache = appendExplorationCache(seed.explorationCache, {
        phase: "planner-todos-explore",
        excerpt: raw,
        agentId: agent.id,
      });
    },
  });

  if (!recovery.ok) {
    const retried = await withSiblingRetry(
      {
        agent,
        modelAtEntry,
        logPrefix: `[${agent.id}]`,
        updateAgentModel: ctx.updateAgentModel,
        emit: ctx.emit,
        getFallbackModel: ctx.getPlannerFallbackModel,
        reason: "sibling-retry: planner JSON parse failed after recovery loop",
        isFallbackAttempt,
      },
      async () => {
        await runPlanner(ctx, agent, seed, true);
      },
    );
    if (retried) return;
    if (ctx.noteProviderStall && /transport|HTTP 429|session usage limit/i.test(recovery.reason)) {
      ctx.noteProviderStall(recovery.reason);
    }
    ctx.appendSystem(`Planner still invalid after recovery (${recovery.reason}). No todos posted.`);
    return;
  }

  let parsed = {
    ok: true as const,
    todos: recovery.value,
    dropped: recovery.dropped as import("./prompts/planner.js").PlannerDropped[],
  };

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
    const { grounded, stripped, rebound } = groundExpectedFiles(t.expectedFiles, seed.repoFiles);
    for (const r of stripped) {
      suspiciousStripped += 1;
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": stripped ungrounded path '${r.path}' (${r.reason}).`,
        createdAt: Date.now(),
      });
    }
    for (const rb of rebound) {
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": rebound '${rb.from}' → '${rb.to}'.`,
        createdAt: Date.now(),
      });
    }
    if (grounded.length === 0) {
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
      expectedFiles: grounded,
      expectedAnchors: t.expectedAnchors,
      expectedSymbols: t.expectedSymbols,
    });
  }
  if (suspiciousStripped > 0 || todosDropped > 0) {
    ctx.appendSystem(
      `Grounding check: stripped ${suspiciousStripped} suspicious path(s); dropped ${todosDropped} todo(s) that lost every path.`,
    );
  }

  const redundancyGroundedTodos: typeof groundedTodos = [];
  let redundancyDropped = 0;
  for (const t of groundedTodos) {
    const plausibleNews = t.expectedFiles.filter(
      (f) => classifyPath(f, seed.repoFiles) === "plausible-new",
    );
    if (plausibleNews.length === 0 || plausibleNews.length < t.expectedFiles.length) {
      redundancyGroundedTodos.push(t);
      continue;
    }
    let allExist = true;
    for (const f of plausibleNews) {
      try {
        await access(join(seed.clonePath, f));
      } catch {
        allExist = false;
        break;
      }
    }
    if (allExist) {
      redundancyDropped++;
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped as redundant — all ${t.expectedFiles.length} expected file(s) already exist on disk (likely created by earlier workers).`,
        createdAt: Date.now(),
      });
      continue;
    }
    redundancyGroundedTodos.push(t);
  }
  // Cross-run: drop todos that match repeated DENY deliberation patterns
  // (skipped in autoApprove high-trust mode).
  let delibFilteredTodos = redundancyGroundedTodos;
  const autoApprove = !!ctx.getActive()?.autoApprove;
  if (!autoApprove) {
    try {
      const { buildDeliberationSeed, filterTodosAgainstDeliberationDenies } = await import(
        "../deliberation/deliberationSeed.js"
      );
      const delibSeed = await buildDeliberationSeed(seed.clonePath);
      if (delibSeed.denyPatterns.length > 0) {
        const { kept, dropped } = filterTodosAgainstDeliberationDenies(
          redundancyGroundedTodos,
          delibSeed.denyPatterns,
        );
        if (dropped.length > 0) {
          ctx.appendSystem(
            `[deliberation] Dropped ${dropped.length} planner todo(s) matching prior DENY patterns.`,
          );
          for (const t of dropped) {
            ctx.findingsPost({
              agentId: agent.id,
              text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped — matches prior deliberation DENY pattern.`,
              createdAt: Date.now(),
            });
          }
          delibFilteredTodos = kept;
        }
      }
    } catch {
      /* best-effort */
    }
  }

  if (redundancyDropped > 0) {
    ctx.appendSystem(
      `Redundancy check: dropped ${redundancyDropped} todo(s) whose files already exist on disk.`,
    );
  }
  groundedTodos.length = 0;
  groundedTodos.push(...delibFilteredTodos);

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

  const panelGrounded = applyPanelConventionToTodos(groundedTodos, seed.repoFiles);
  if (panelGrounded.notes.length > 0 || panelGrounded.skipped.length > 0) {
    for (const n of panelGrounded.notes) {
      ctx.findingsPost({
        agentId: agent.id,
        text: `Panel convention (${n.description.slice(0, 60)}…): ${n.note}`,
        createdAt: Date.now(),
      });
    }
    for (const s of panelGrounded.skipped) {
      ctx.findingsPost({
        agentId: agent.id,
        text: `Panel todo dropped: ${s}`,
        createdAt: Date.now(),
      });
    }
    ctx.appendSystem(
      `Panel convention: adjusted ${panelGrounded.notes.length} todo(s); dropped ${panelGrounded.skipped.length} redundant panel todo(s).`,
    );
  }
  groundedTodos.length = 0;
  groundedTodos.push(...panelGrounded.todos);

  const batchOverlaps = detectTodoBatchFileOverlaps(groundedTodos);
  if (batchOverlaps.length > 0) {
    ctx.appendSystem(
      `Planner provisioning: ${batchOverlaps.length} file(s) shared across todos — workers will serialize edits on those paths.`,
    );
    for (const o of batchOverlaps.slice(0, 8)) {
      ctx.findingsPost({
        agentId: agent.id,
        text: `Todo file overlap on '${o.file}' across: ${o.todoIds.join(" | ")}. Workers cannot safely edit the same file concurrently.`,
        createdAt: Date.now(),
      });
    }
  }

  if (groundedTodos.length === 0) {
    // If ALL todos were dropped by the redundancy check, don't trigger
    // sibling-retry — the planner produced valid work that was already
    // done. Retrying would waste a prompt on the same result.
    if (redundancyDropped > 0 && todosDropped === 0 && suspiciousStripped === 0) {
      ctx.appendSystem(
        `All ${redundancyDropped} todo(s) were redundant — files already exist on disk. Skipping sibling-retry.`,
      );
      return;
    }

    // Soft recovery (d279548d): schema-only drops → salvage with repo file list
    // before sibling-retry / no-progress exit.
    if (parsed.dropped.length > 0) {
      const salvaged = salvagePlannerTodosFromDropped(parsed.dropped, seed.repoFiles);
      if (salvaged.length > 0) {
        let salvageKept = 0;
        for (const t of salvaged) {
          const { grounded } = groundExpectedFiles(t.expectedFiles, seed.repoFiles);
          if (grounded.length === 0) continue;
          groundedTodos.push({
            description: t.description,
            expectedFiles: grounded,
            expectedAnchors: t.expectedAnchors,
            expectedSymbols: t.expectedSymbols,
          });
          salvageKept += 1;
        }
        if (salvageKept > 0) {
          ctx.appendSystem(
            `Planner salvage: recovered ${salvageKept} todo(s) from ${parsed.dropped.length} schema-dropped item(s).`,
          );
        }
      }
    }

    // Last soft recovery: emergency micro-todos from seed/contract/directive
    // so a schema-storm does not immediately hard-stop with zero board work.
    if (groundedTodos.length === 0) {
      const emergency = buildEmergencyPlannerTodos(seed, ctx.getContract());
      if (emergency.length > 0) {
        groundedTodos.push(...emergency);
        ctx.appendSystem(
          `Planner emergency seed: posted ${emergency.length} grounded micro-todo(s) after schema/grounding wipe — avoiding empty-board no-progress.`,
        );
      }
    }

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
  const sessionHint = (ctx as { getSessionPlannerHint?: () => string | undefined }).getSessionPlannerHint?.();
  ctx.appendSystem(
    "Auditor produced no new work; trying a planner pass against the current contract before stopping.",
  );
  if (sessionHint) {
    ctx.appendSystem(`[control] Planner fallback hint: ${sessionHint.slice(0, 300)}`);
  }
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
