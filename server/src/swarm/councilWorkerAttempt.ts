/**
 * Single worker emit+apply attempt (primary / repair / failover).
 * Extracted from councilWorkerRunner — includes applyOrGroundedRepair path.
 * Literature is never re-entered on repairFrom (opts.repairFrom → skip).
 */

import type { Agent } from "../services/AgentManager.js";
import type { QueuedTodo } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import { applyAndCommit } from "./blackboard/WorkerPipeline.js";
import {
  buildWorkerUserPrompt,
  buildWorkerRepairPrompt,
  isRepairableApplyMiss,
  parseWorkerResponse,
  validateHunkPayload,
  WORKER_SYSTEM_PROMPT,
} from "./blackboard/prompts/worker.js";
import { mergeAnchorsForTodo } from "./grounding/mergeAnchors.js";
import { repairAndParseJson } from "./repairJson.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText } from "./councilUtils.js";
import { isWebToolsEnabled } from "./toolProfiles.js";
import { EMIT_ONLY_PROFILE_ID } from "../../../shared/src/toolProfiles.js";
import { makeBufferedToolHandler } from "./toolCallTranscript.js";
import { wrapProgressContextForPrompt } from "./councilProgressLedger.js";
import {
  noteMissRecoveredDet,
  noteMissRecoveredLlm,
  noteMissTerminal,
  noteRepairFailure,
  noteRepairSuccess,
} from "./applyIntegrityStats.js";
import { classifyWorkerSkip } from "@ollama-swarm/shared/skipClassify";
import { summarizeWorkerFailureReason } from "./councilWorkerFallback.js";
import { applyOrGroundedRepair } from "./applyOrGroundedRepair.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { runCouncilLiteratureResearch } from "./councilWorkerLiterature.js";
import type { ToolResultHook } from "../tools/ToolDispatcher.js";
import type {
  WorkerAttemptResult,
  WorkerRunnerContext,
} from "./councilWorkerTypes.js";

export function wrapCouncilPromptWithControlHints(
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

export function buildCouncilToolCoachHook(
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
      autoApprove: state.cfg.autoApprove,
      brainOs: (state.cfg as { brainOs?: boolean | object }).brainOs as boolean | undefined,
      helperModel: state.cfg.auditorModel ?? state.cfg.model,
    });
  };
}

export function parseWorkerResponseWithRepair(
  raw: string,
  expectedFiles: string[],
): ReturnType<typeof parseWorkerResponse> {
  const direct = parseWorkerResponse(raw, expectedFiles);
  if (direct.ok) return direct;
  const repaired = repairAndParseJson(raw);
  if (repaired?.value !== undefined && typeof repaired.value === "object" && repaired.value !== null) {
    const second = parseWorkerResponse(JSON.stringify(repaired.value), expectedFiles);
    if (second.ok) return second;
    // Surface schema/allow-list failure instead of the original fence/parse error
    // so stage-2 recovery and operators see the real problem (83dc5910).
    if (!second.ok) return second;
  }
  return direct;
}

/**
 * One emit → parse → apply → optional grounded repair attempt.
 * Does not implement stage-2/3 retry policy (see executeTodoWithRetryChain).
 */
export async function tryWorkerPrompt(
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
  // RR-B: unified merge — planner expected ∪ description ∪ autoDetect.
  const expectedAnchors: string[] = mergeAnchorsForTodo({
    todoDescription: todo.description,
    expectedAnchors: todo.expectedAnchors ? [...todo.expectedAnchors] : undefined,
    fileContents,
    expectedFiles,
  });

  const progressBlock = wrapProgressContextForPrompt(state.progressContext ?? "");
  const priorMiss = todo.lastApplyMiss
    ? {
        file: todo.lastApplyMiss.file,
        kind: todo.lastApplyMiss.kind,
        op: todo.lastApplyMiss.op,
        needle: todo.lastApplyMiss.needle,
        matchCount: todo.lastApplyMiss.matchCount,
        message: todo.lastApplyMiss.message,
        uniqueCandidates: [...todo.lastApplyMiss.uniqueCandidates],
        nearbyExcerpt: todo.lastApplyMiss.nearbyExcerpt,
      }
    : undefined;
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
        lastApplyMiss: priorMiss,
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
    // Live eee6718f/9f449937: workers with tool budgets emitted <think>-only
    // blobs and failed JSON parse 10–50×. Literature already ran separately;
    // file windows are in the prompt — emit-only + ollamaFormat json forces
    // an envelope. formatExpect still arms the stream sniff.
    const raw = await promptWithFailoverAuto(agent, basePrompt, {
      manager: state.manager as any,
      agentName: EMIT_ONLY_PROFILE_ID,
      signal: controller.signal,
      maxToolTurns: 1,
      formatExpect: "json",
      ollamaFormat: "json" as const,
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

    // Git-native: worker used write/edit tools; commit dirty working tree (no re-apply).
    if (
      parsed.ok
      && !parsed.skip
      && (parsed.workingTree === true
        || (parsed.hunks.length === 0 && (parsed.filesTouched?.length ?? 0) > 0))
    ) {
      const { commitWorkingTreeFiles, makeWorkingTreeProposal } = await import(
        "./blackboard/workingTreeCommit.js"
      );
      const files =
        parsed.filesTouched && parsed.filesTouched.length > 0
          ? parsed.filesTouched
          : expectedFiles;
      const proposal = makeWorkingTreeProposal(
        files,
        parsed.gitMessage ?? todo.description.slice(0, 120),
      );
      const wtResult = await commitWorkingTreeFiles({
        todoId: todo.id,
        workerId: agent.id,
        files: proposal.files,
        message: proposal.hunks[0]?.message ?? todo.description.slice(0, 120),
        fs: fsAdapter,
        git: gitAdapter,
        runId: state.cfg.runId,
        clonePath: state.clonePath,
      });
      if (wtResult.ok && wtResult.filesWritten.length > 0) {
        try {
          state.todoQueue.clearLastApplyMiss(todo.id);
        } catch {
          /* ignore */
        }
        ctx.appendSystem(
          `[execution] ${agent.id} ✓ git-native working-tree commit — ${wtResult.commitSha?.slice(0, 7)} ` +
            `(${wtResult.filesWritten.length} file(s)).`,
        );
        return { outcome: "completed" };
      }
      return {
        outcome: "retry",
        reason: wtResult.ok
          ? "working-tree commit wrote zero files"
          : (wtResult.reason || "working-tree commit failed"),
        lastResponse: res,
      };
    }

    if (parsed.ok && parsed.hunks.length > 0 && !parsed.skip) {
      // Auto-demote oversized replace/create → write/replace_between (83dc5910).
      const sizeCheck = validateHunkPayload(parsed.hunks, fileContents);
      if (!sizeCheck.ok) {
        return { outcome: "retry", reason: sizeCheck.reason, lastResponse: res };
      }
      if (sizeCheck.ok && sizeCheck.demotions && sizeCheck.demotions.length > 0) {
        ctx.appendSystem(
          `[execution] ${agent.id} auto-demoted ${sizeCheck.demotions.length} oversized hunk(s): ` +
            sizeCheck.demotions
              .map((d) => `${d.file} ${d.from}→${d.to}`)
              .join("; "),
        );
      }
      // RR-A: never coerce create→replace with a 2KB prefix search (silent
      // half-file corruption). Also refuse silent create→write full overwrite
      // (live risk: model says create but path exists → whole file replaced).
      // Fail closed with a clear re-emit reason so stage-2 can fix the op.
      // Note: demote may already have turned create→write; check post-demote ops.
      for (const h of sizeCheck.hunks) {
        if ((h as any).op === "create" && fileContents[(h as any).file] !== null) {
          return {
            outcome: "retry",
            reason:
              `create on existing file "${(h as any).file}" — use op "write" (full rewrite) ` +
              `or "replace"/"replace_between" (anchor edit); refusing silent full overwrite`,
            lastResponse: res,
          };
        }
      }
      const fixedHunks = sizeCheck.hunks;

      const applyResult = await applyAndCommit({
        todoId: todo.id,
        workerId: agent.id,
        expectedFiles,
        hunks: fixedHunks,
        fs: fsAdapter,
        git: gitAdapter,
        runId: state.cfg.runId,
        clonePath: state.clonePath,
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
        try {
          state.todoQueue.clearLastApplyMiss(todo.id);
        } catch {
          /* ignore */
        }
        ctx.appendSystem(`[execution] ${agent.id} ✓ applied — ${applyResult.commitSha?.slice(0, 7)}.`);
        return { outcome: "completed" };
      }

      // Persist miss for next first-pass seed (RR-B lastApplyMiss).
      if (applyResult.miss) {
        try {
          state.todoQueue.setLastApplyMiss(todo.id, {
            file: applyResult.miss.file,
            kind: applyResult.miss.kind,
            op: applyResult.miss.op,
            needle: applyResult.miss.needle,
            matchCount: applyResult.miss.matchCount,
            message: applyResult.miss.message,
            uniqueCandidates: applyResult.miss.uniqueCandidates,
            nearbyExcerpt: applyResult.miss.nearbyExcerpt,
            at: Date.now(),
          });
        } catch {
          /* ignore */
        }
      }

      // Shared applyOrGroundedRepair core (same quality bar as blackboard/auditor).
      // Never re-enter literature research on this pure apply-repair path.
      if (
        isRepairableApplyMiss({
          miss: applyResult.miss,
          reason: applyResult.reason,
        })
      ) {
        const miss = applyResult.miss;
        ctx.appendSystem(
          `[apply-miss] kind=${miss?.kind ?? "unknown"} file=${miss?.file ?? "?"}` +
            (miss?.needle ? ` needle=${JSON.stringify(miss.needle).slice(0, 80)}` : "") +
            ` — applyOrGroundedRepair (no literature)`,
        );
        const liveTexts: Record<string, string | null> = {};
        for (const f of expectedFiles) {
          try {
            liveTexts[f] = await fsAdapter.read(f);
          } catch {
            liveTexts[f] = fileContents[f] ?? null;
          }
        }
        const grounded = await applyOrGroundedRepair({
          hunks: fixedHunks,
          currentTextsByFile: liveTexts,
          expectedFiles,
          readFile: async (p) => {
            try {
              return await fsAdapter.read(p);
            } catch {
              return null;
            }
          },
          callModel: async (repairPrompt) => {
            const repairRaw = await promptWithFailoverAuto(
              agent,
              wrapCouncilPromptWithControlHints(
                `${WORKER_SYSTEM_PROMPT}\n\n${repairPrompt}`,
                agent.id,
                ctx,
              ),
              {
                manager: state.manager as any,
                agentName: EMIT_ONLY_PROFILE_ID,
                signal: controller.signal,
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
              },
              state.cfg.providerFailover,
            );
            const repairText = extractProviderText(repairRaw);
            if (repairText) {
              state.appendAgent(agent, repairText, { role: "worker" });
            }
            return repairText ?? "";
          },
          maxGroundedRepairs: 1,
        });
        if (grounded.ok && grounded.hunks) {
          if (grounded.deterministicCandidate) {
            ctx.appendSystem(
              `[apply-miss] recovered via deterministic uniqueCandidates ` +
                `(SWARM_APPLY_DETERMINISTIC_CANDIDATE) — not a terminal fail`,
            );
          }
          const repairResult = await applyAndCommit({
            todoId: todo.id,
            workerId: agent.id,
            expectedFiles,
            hunks: grounded.hunks,
            fs: fsAdapter,
            git: gitAdapter,
            runId: state.cfg.runId,
            clonePath: state.clonePath,
          });
          if (repairResult.ok) {
            if (!repairResult.filesWritten || repairResult.filesWritten.length === 0) {
              noteRepairFailure(state.cfg.runId);
              noteMissTerminal(state.cfg.runId);
              return {
                outcome: "retry",
                reason: "hunk repair wrote zero files (no-op) — not a successful commit",
                lastResponse: res,
              };
            }
            noteRepairSuccess(state.cfg.runId);
            if (grounded.deterministicCandidate) {
              noteMissRecoveredDet(state.cfg.runId);
            } else {
              noteMissRecoveredLlm(state.cfg.runId);
            }
            try {
              state.todoQueue.clearLastApplyMiss(todo.id);
            } catch {
              /* ignore */
            }
            const how = grounded.deterministicCandidate
              ? "deterministic-candidate"
              : "hunk repair";
            ctx.appendSystem(
              `[execution] ${agent.id} ✓ applied (${how}) — ${repairResult.commitSha?.slice(0, 7)}.`,
            );
            return { outcome: "completed" };
          }
          noteRepairFailure(state.cfg.runId);
          noteMissTerminal(state.cfg.runId);
          if (repairResult.miss) {
            try {
              state.todoQueue.setLastApplyMiss(todo.id, {
                file: repairResult.miss.file,
                kind: repairResult.miss.kind,
                op: repairResult.miss.op,
                needle: repairResult.miss.needle,
                matchCount: repairResult.miss.matchCount,
                message: repairResult.miss.message,
                uniqueCandidates: repairResult.miss.uniqueCandidates,
                nearbyExcerpt: repairResult.miss.nearbyExcerpt,
                at: Date.now(),
              });
            } catch {
              /* ignore */
            }
          }
        } else {
          noteRepairFailure(state.cfg.runId);
          noteMissTerminal(state.cfg.runId);
          if (grounded.miss) {
            try {
              state.todoQueue.setLastApplyMiss(todo.id, {
                file: grounded.miss.file,
                kind: grounded.miss.kind,
                op: grounded.miss.op,
                needle: grounded.miss.needle,
                matchCount: grounded.miss.matchCount,
                message: grounded.miss.message,
                uniqueCandidates: grounded.miss.uniqueCandidates,
                nearbyExcerpt: grounded.miss.nearbyExcerpt,
                at: Date.now(),
              });
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        // Unrepairable miss kinds — still terminal for this attempt.
        noteMissTerminal(state.cfg.runId);
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
      // Garbage placeholders ("reason", "none") are not real skips — retry once
      // as no_hunks so settlement does not thrash on fake soft-skips.
      const classified = classifyWorkerSkip(parsed.skip);
      if (!classified.ok) {
        ctx.appendSystem(
          `[execution] ${agent.id} rejected garbage skip ${JSON.stringify(parsed.skip)} — treating as no hunks`,
        );
        return {
          outcome: "retry",
          reason: "worker returned no hunks (garbage skip placeholder)",
          lastResponse: res,
        };
      }
      const skipReason = classified.permanent
        ? `permanent:${classified.code.replace(/_/g, "-")}: ${classified.reason}`
        : classified.reason;
      ctx.appendSystem(
        `[execution] ${agent.id} skipped (${classified.code}): ${classified.reason.slice(0, 200)}`,
      );
      return { outcome: "skipped", reason: skipReason };
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
