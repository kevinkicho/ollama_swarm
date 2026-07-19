/**
 * Worker JSON parse → repair → auditor salvage → sibling retry cascade.
 * Extracted from workerRunner.executeWorkerTodo.
 *
 * 926054b0: repair used the full worker tool profile + full seed, so gemma
 * kept calling tools during "JSON repair" (tool-coach thrash) and fences
 * still failed after a useless repair turn. Repair is emit-only + short
 * framing; pure-think/empty skip straight to salvage.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo, CommitTier } from "./types.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ToolTraceEntry } from "../toolCallTranscript.js";
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
import { repairAndParseJson } from "../repairJson.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";
import { tryDiskFirstWorkerParse } from "./diskFirstWorkerSettle.js";

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
  /**
   * Tool invocations from the primary worker turn (peeked before appendAgent
   * consumes the pending buffer). Used for disk-first settle.
   */
  toolTrace?: readonly ToolTraceEntry[];
  /** Clone path for git dirty-tree detection when tool previews are sparse. */
  getClonePath?: () => string;
}

/** Failures where another full worker-shaped repair turn rarely helps. */
function shouldSkipLlmJsonRepair(reason: string): boolean {
  return (
    /empty response|pure <think>|no JSON envelope|format\/provider/i.test(reason)
  );
}

export async function runWorkerParseCascade(
  ctx: WorkerParseCascadeCtx,
  agent: Agent,
  todo: Todo,
  seed: WorkerSeed,
  response: string,
  _workerProfile: ProfileName,
  workerActivity: {
    kind: string;
    label: string;
    mode?: "emit";
    maxToolTurns?: number;
    promptWallClockMs?: number;
  },
  modelAtEntry: string,
): Promise<WorkerParseResult> {
  void workerActivity; // API retained for call-site stability; repair uses emit-only opts.
  let parsed = parseWorkerResponse(response, todo.expectedFiles);
  let commitTier: CommitTier = "parse";
  if (parsed.ok) {
    return { ok: true, parsed, commitTier };
  }

  // Deterministic soft-repair (fences, bare keys, smart quotes) before any LLM call.
  const soft = repairAndParseJson(response);
  if (soft?.value !== undefined && typeof soft.value === "object" && soft.value !== null) {
    const second = parseWorkerResponse(JSON.stringify(soft.value), todo.expectedFiles);
    if (second.ok) {
      ctx.appendSystem(
        `[${agent.id}] [v2] worker JSON recovered via soft-repair (${soft.strategy}) — skipping LLM repair.`,
      );
      return { ok: true, parsed: second, commitTier: "parse" };
    }
  }

  // Disk-first settle: write/edit tools (or dirty git ∩ expected) already
  // mutated the tree, but the model never emitted a valid JSON envelope.
  // Prefer real disk over salvage/sibling thrash.
  {
    const clonePath =
      (ctx.getClonePath?.() ?? ctx.getActive()?.localPath ?? "").trim();
    if (clonePath) {
      try {
        const disk = await tryDiskFirstWorkerParse({
          expectedFiles: todo.expectedFiles,
          toolTrace: ctx.toolTrace ?? [],
          clonePath,
          todoDescription: todo.description,
        });
        if (disk) {
          const n = disk.filesTouched?.length ?? 0;
          ctx.appendSystem(
            `[${agent.id}] [v2] disk-first settle — synthetic workingTree for ${n} file(s)` +
              ` after parse fail (${parsed.reason.slice(0, 80)}); auditor will review git reality.`,
          );
          return { ok: true, parsed: disk, commitTier: "disk-first" };
        }
      } catch (err) {
        ctx.appendSystem(
          `[${agent.id}] [v2] disk-first settle error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  ctx.bumpJsonRepairs(agent.id);
  let repair = "";
  if (shouldSkipLlmJsonRepair(parsed.reason)) {
    ctx.appendSystem(
      `[${agent.id}] [v2] worker JSON invalid (${parsed.reason}); skipping LLM repair — going to salvage/sibling.`,
    );
  } else {
    ctx.appendSystem(
      `[${agent.id}] [v2] worker JSON invalid (${parsed.reason}); issuing emit-only repair prompt.`,
    );
    try {
      // Emit-only: no tools (926054b0 tool-coach thrash on propose_hunks during "repair").
      // Short framing only — do not re-paste the full windowed seed.
      repair = await ctx.promptAgent(
        agent,
        `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
        EMIT_ONLY_PROFILE_ID as ProfileName,
        "json",
        WORKER_HUNKS_JSON_SCHEMA,
        {
          kind: "worker",
          label: `repair ${todo.id.slice(0, 8)}`,
          mode: "emit",
          maxToolTurns: 1,
        },
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
  }

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
    // Capture before the sibling callback — TS loses narrowing across reassignment.
    const parseFailReason = parsed.reason;
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
        // Sibling re-emit: emit-only (same thrash as repair if tools stay on).
        const siblingResponse = await ctx.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}\n\n` +
            `Previous parse failed: ${parseFailReason}. Emit valid {"hunks":[...]} JSON only. No tools.`,
          EMIT_ONLY_PROFILE_ID as ProfileName,
          "json",
          WORKER_HUNKS_JSON_SCHEMA,
          {
            kind: "worker",
            label: `sibling-emit ${todo.id.slice(0, 8)}`,
            mode: "emit",
            maxToolTurns: 1,
          },
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
    // Brain OS: one agentic chance after parse cascade exhaustion (926054b0 thrash).
    try {
      const active = ctx.getActive();
      const { createRunBrainOs, dispatchBrainOsConflict, resolveBrainOsConfig } = await import(
        "../brainOs/adapter.js"
      );
      const bcfg = resolveBrainOsConfig({
        autoApprove: active?.autoApprove,
        brainOs: (active as { brainOs?: boolean | object } | undefined)?.brainOs as
          | boolean
          | undefined,
      });
      if (bcfg.enabled && active?.localPath && active?.runId) {
        ctx.appendSystem(
          `[${agent.id}] [brain-os] parse_fail after cascade — recruiting helper`,
        );
        const bos = createRunBrainOs(
          {
            autoApprove: active.autoApprove,
            brainOs: bcfg,
            auditorModel: active.auditorModel,
            model: active.model,
          },
          {
            appendSystem: (t) => ctx.appendSystem(t),
            proposeHunks: (id, hunks, files) => {
              try {
                ctx.getWrappers().proposeCommitQ(id, hunks, files);
              } catch {
                /* */
              }
            },
            skipTodo: (id, reason) => {
              try {
                ctx.getWrappers().skipTodoQ(id, reason);
              } catch {
                /* */
              }
            },
          },
        );
        const r = await dispatchBrainOsConflict(
          bos,
          {
            runId: active.runId,
            kind: "parse_fail",
            clonePath: active.localPath,
            privileges: active.autoApprove ? "runner" : "repairer",
            todoId: todo.id,
            lastErrors: [parsed.reason, `todo: ${todo.description.slice(0, 200)}`],
            relevantFiles: [...todo.expectedFiles],
            autoApprove: active.autoApprove,
            helperModel: active.auditorModel ?? active.model,
            phase: "worker_parse_cascade",
          },
          {
            appendSystem: (t) => ctx.appendSystem(t),
            proposeHunks: (id, hunks, files) => {
              try {
                ctx.getWrappers().proposeCommitQ(id, hunks, files);
              } catch {
                /* */
              }
            },
            skipTodo: (id, reason) => {
              try {
                ctx.getWrappers().skipTodoQ(id, reason);
              } catch {
                /* */
              }
            },
          },
        );
        if (r.status === "resolved" || r.status === "partial") {
          ctx.appendSystem(
            `[${agent.id}] [brain-os] parse_fail handled: ${r.summary.slice(0, 200)}`,
          );
          // Helper may have skip/complete/propose'd; fail only if still claimable.
          try {
            ctx.getWrappers().failTodoQ(
              todo.id,
              `[v2] parse cascade exhausted after brain-os (${r.status}): ${parsed.reason}`,
              "repair",
            );
          } catch {
            /* already settled by effects */
          }
          ctx.bumpRejectedAttempts(agent.id);
          return { ok: false, outcome: "stale" };
        }
      }
    } catch (err) {
      ctx.appendSystem(
        `[${agent.id}] [brain-os] parse_fail dispatch error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
