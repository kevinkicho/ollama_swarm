/**
 * Pre-prompt setup for a worker hunk todo: file reads, anchors, scaffold,
 * literature research, seed assembly.
 * Extracted from workerRunner.executeWorkerTodo.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo } from "./types.js";
import type { WorkerSeed } from "./prompts/worker.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TranscriptEntry } from "../../types.js";
import type { ToolTraceEntry } from "../toolCallTranscript.js";
import type { AgentManager } from "../../services/AgentManager.js";
import type { AgentState } from "../../types.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import { autoDetectAnchors } from "./autoAnchor.js";
import { getModelBudget } from "../modelContextBudget.js";
import { isWebToolsEnabled } from "../toolProfiles.js";
import { resolveWorkerScaffoldPlan } from "./workerScaffold.js";
import { runWorkerLiteratureResearch } from "./workerLiteratureResearch.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import {
  loadEndpointCatalogSnapshot,
  renderEndpointCatalogBlock,
  todoTouchesApiSurface,
} from "./endpointCatalogContext.js";
import { pheromoneHeatmap } from "../pheromoneHeatmap.js";
import { getDispositionForTurn } from "../roundRobinPromptHelpers.js";

export interface WorkerTodoPrepCtx {
  getActive: () => RunConfig | undefined;
  getAmendments?: () => Array<{ ts: number; text: string }>;
  getTranscript: () => readonly TranscriptEntry[];
  getRepoFiles?: () => readonly string[];
  getWorkerRoles: () => Map<string, string>;
  getDispositionCycle: () => Map<string, number>;
  readExpectedFiles: (files: string[]) => Promise<Record<string, string | null>>;
  getWrappers: () => TodoQueueWrappers;
  appendSystem: (msg: string) => void;
  getManager: () => AgentManager;
  emitAgentState: (s: AgentState) => void;
  getActiveAborts: () => Set<AbortController>;
  isStopping: () => boolean;
  isDraining: () => boolean;
  appendAgent: (agent: Agent, text: string) => void;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
}

export type WorkerTodoPrepResult =
  | { ok: false; outcome: "stale" }
  | {
      ok: true;
      seed: WorkerSeed;
      scaffoldPlan: Awaited<ReturnType<typeof resolveWorkerScaffoldPlan>> | undefined;
      contents: Record<string, string | null>;
      budget: ReturnType<typeof getModelBudget>;
      activeCfg: RunConfig | undefined;
      workerCwd: string;
    };

export async function prepareWorkerTodoSeed(
  ctx: WorkerTodoPrepCtx,
  agent: Agent,
  todo: Todo,
): Promise<WorkerTodoPrepResult> {
  let contents: Record<string, string | null>;
  try {
    const allFiles = [...todo.expectedFiles, ...(todo.contextFiles ?? [])];
    contents = await ctx.readExpectedFiles(allFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.getWrappers().failTodoQ(todo.id, `[v2] read failure: ${msg}`);
    return { ok: false, outcome: "stale" };
  }

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
  const repoFiles = ctx.getRepoFiles?.() ?? [];
  const scaffoldPlan =
    workerCwd && repoFiles.length > 0
      ? await resolveWorkerScaffoldPlan({
          description: todo.description,
          expectedFiles: todo.expectedFiles,
          fileContents: contents,
          repoFiles,
          clonePath: workerCwd,
        })
      : undefined;
  if (scaffoldPlan) {
    ctx.appendSystem(
      `[${agent.id}] create-scaffold mode for todo ${todo.id.slice(0, 8)} — emit-only with exemplar panel.`,
    );
  }
  const researchNotes =
    scaffoldPlan?.skipLiterature || !webToolsEnabled
      ? undefined
      : await runWorkerLiteratureResearch(ctx, agent, todo, workerCwd);
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

  let projectGraphSlice: string | undefined;
  if (activeCfg?.localPath) {
    try {
      const { getProjectGraphSliceForClone } = await import("../../projectGraph/service.js");
      projectGraphSlice = await getProjectGraphSliceForClone(workerCwd, activeCfg);
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
    ...(projectGraphSlice ? { projectGraphSlice } : {}),
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

  return {
    ok: true,
    seed,
    scaffoldPlan,
    contents,
    budget,
    activeCfg,
    workerCwd,
  };
}
