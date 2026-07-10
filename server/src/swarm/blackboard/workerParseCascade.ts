/**
 * Worker JSON parse → repair → auditor salvage → sibling retry cascade.
 * Extracted from workerRunner.executeWorkerTodo.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo, CommitTier } from "./types.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import {
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";
import { WORKER_HUNKS_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { runParseSalvage } from "./parseSalvage.js";
import { withSiblingRetry } from "./siblingRetry.js";
import { isPromptHaltError } from "./lifecycleState.js";

export type WorkerParseResult =
  | { ok: true; parsed: Extract<ReturnType<typeof parseWorkerResponse>, { ok: true }>; commitTier: CommitTier }
  | { ok: false; outcome: "stale" | "aborted" };

export interface WorkerParseCascadeCtx {
  isStopping: () => boolean;
  isDraining: () => boolean;
  getWrappers: () => TodoQueueWrappers;
  getAuditor: () => Agent | undefined;
  getActive: () => RunConfig | undefined;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: "auditor-salvage" },
  ) => void;
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
  bumpJsonRepairs: (agentId: string) => void;
  bumpPromptErrors: (agentId: string) => void;
  bumpRejectedAttempts: (agentId: string) => void;
  updateAgentModel: (agentId: string, model: string) => void;
  emit: (ev: Record<string, unknown>) => void;
  getPlannerFallbackModel: () => string | undefined;
  workerToolProfile: (kind: "hunk" | "build" | "read") => ProfileName;
}

export async function runWorkerParseCascade(
  ctx: WorkerParseCascadeCtx,
  agent: Agent,
  todo: Todo,
  seed: WorkerSeed,
  response: string,
  workerProfile: ProfileName,
  workerActivity: {
    kind: string;
    label: string;
    mode?: "emit";
    maxToolTurns?: number;
    promptWallClockMs?: number;
  },
  modelAtEntry: string,
): Promise<WorkerParseResult> {
  let parsed = parseWorkerResponse(response, todo.expectedFiles);
  let commitTier: CommitTier = "parse";
  if (parsed.ok) {
    return { ok: true, parsed, commitTier };
  }

  ctx.bumpJsonRepairs(agent.id);
  ctx.appendSystem(
    `[${agent.id}] [v2] worker JSON invalid (${parsed.reason}); issuing repair prompt.`,
  );
  let repair: string;
  try {
    repair = await ctx.promptAgent(
      agent,
      `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
      workerProfile,
      "json",
      WORKER_HUNKS_JSON_SCHEMA,
      { ...workerActivity, label: `repair ${todo.id.slice(0, 8)}` },
    );
  } catch (err) {
    if (isPromptHaltError(err, ctx.isStopping, ctx.isDraining)) {
      return { ok: false, outcome: "aborted" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.getWrappers().failTodoQ(todo.id, `[v2] worker repair prompt failed: ${msg}`, "repair");
    ctx.bumpPromptErrors(agent.id);
    ctx.bumpRejectedAttempts(agent.id);
    return { ok: false, outcome: "stale" };
  }
  if (ctx.isStopping()) return { ok: false, outcome: "aborted" };
  ctx.appendAgent(agent, repair);
  parsed = parseWorkerResponse(repair, todo.expectedFiles);
  if (parsed.ok) commitTier = "repair";

  if (!parsed.ok) {
    const auditor = ctx.getAuditor();
    if (auditor && !ctx.isStopping()) {
      ctx.appendSystem(
        `[${agent.id}] [v2] parse failed after repair — routing raw response to auditor for JSON salvage.`,
      );
      try {
        const salvage = await runParseSalvage(
          auditor,
          {
            getStopping: ctx.isStopping,
            appendSystem: ctx.appendSystem,
            appendAgent: (a, t, o) => ctx.appendAgent(a, t, o),
            promptPlannerSafely: (a, p, profile, schema) =>
              ctx
                .promptAgent(
                  a,
                  p,
                  profile ?? ctx.workerToolProfile("read"),
                  "json",
                  schema,
                )
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
        ctx.appendSystem(
          `⚠ [${agent.id}] [v2] auditor interpretation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
        if (ctx.isStopping()) {
          stopAborted = true;
          return;
        }
        const siblingResponse = await ctx.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`,
          ctx.workerToolProfile("hunk"),
          "json",
          WORKER_HUNKS_JSON_SCHEMA,
        );
        if (ctx.isStopping()) {
          stopAborted = true;
          return;
        }
        ctx.appendAgent(agent, siblingResponse);
        const siblingParsed = parseWorkerResponse(siblingResponse, todo.expectedFiles);
        if (siblingParsed.ok && siblingParsed.hunks.length > 0 && !siblingParsed.skip) {
          parsed = siblingParsed;
          commitTier = "sibling";
          ctx.appendSystem(
            `[${agent.id}] [v2] sibling-retry succeeded — ${siblingParsed.hunks.length} hunk(s) from ${agent.model}.`,
          );
        }
      },
    );
    if (stopAborted) return { ok: false, outcome: "aborted" };
  }

  if (!parsed.ok) {
    ctx.getWrappers().failTodoQ(
      todo.id,
      `[v2] worker produced invalid JSON after repair: ${parsed.reason}`,
      "repair",
    );
    ctx.bumpRejectedAttempts(agent.id);
    return { ok: false, outcome: "stale" };
  }

  return { ok: true, parsed, commitTier };
}
