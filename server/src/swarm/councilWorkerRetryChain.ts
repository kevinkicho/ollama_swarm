/**
 * Stage 1–3 worker recovery chain (primary → class-aware repair → failover).
 * Extracted from councilWorkerRunner.
 *
 * Thrash invariant (120b2044): apply_miss does NOT full same-model re-emit —
 * stage-1 already ran applyOrGroundedRepair (det multi-candidate + LLM).
 * Stage 3 still allows one different failover model.
 */

import type { Agent } from "../services/AgentManager.js";
import type { QueuedTodo } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import { withSiblingRetry } from "./blackboard/siblingRetry.js";
import { classifyCycleFailReason } from "@ollama-swarm/shared/cycleIntegrityReport";
import {
  councilWorkerFallbackModel,
  summarizeWorkerFailureReason,
} from "./councilWorkerFallback.js";
import {
  BARE_TEST_RUNNERS,
  shouldDemoteBuildToHunks,
} from "./councilTodoClassify.js";
import { tryWorkerPrompt } from "./councilWorkerAttempt.js";
import {
  isWorkerRetry,
  type TodoExecuteResult,
  type WorkerAttemptResult,
  type WorkerRunnerContext,
} from "./councilWorkerTypes.js";
import { checkBuildCommand } from "./blackboard/buildCommandAllowlist.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import { resolveToolProfile } from "./toolProfiles.js";
import { makeBufferedToolHandler } from "./toolCallTranscript.js";
import simpleGit from "simple-git";

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
        // Wire stop/drain abort so build bash todos don't outlive hard stop.
        signal: controller.signal,
        onTool: makeBufferedToolHandler(state.pendingToolTraceByAgent, agent.id),
      });
      const text = extractText(res)?.trim();
      if (text) {
        state.appendAgent(agent, text);
      }
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
      ctx.unregisterTodoAbort?.(agent.id);
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
      const bareRunner = BARE_TEST_RUNNERS.some(
        (r) => command === r || command.startsWith(`${r} `),
      );
      if (bareRunner) {
        return {
          outcome: "failed",
          error:
            `build_misroute: bare \`${command}\` produced no file changes — ` +
            `create/edit tests via hunks first, then run the suite`,
        };
      }
      return {
        outcome: "failed",
        error: "build_misroute: build command produced no file changes",
      };
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

export async function executeTodoWithRetryChain(
  agent: Agent,
  todo: QueuedTodo,
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<TodoExecuteResult> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };

  if (todo.kind === "build" && todo.command) {
    // Defense-in-depth (run 2964afe8): queued build todos from older classify
    // or mis-posted audit still demote create-test prose onto the hunk path.
    if (shouldDemoteBuildToHunks(todo.description, todo.command)) {
      ctx.appendSystem(
        `[execution] ${agent.id} demoting build→hunks for create/author intent ` +
          `(was command: \`${todo.command}\`) — build worker cannot create test files.`,
      );
      // Fall through to hunk path (do not call executeCouncilBuildTodo).
    } else {
      return executeCouncilBuildTodo(agent, todo, state, gitAdapter, ctx);
    }
  }

  const expectedFiles = [...todo.expectedFiles];

  // Stage 1: Primary prompt (includes apply + det multi-candidate + LLM grounded repair)
  const primaryResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (!isWorkerRetry(primaryResult)) return primaryResult;
  const primaryReason = summarizeWorkerFailureReason(primaryResult.reason);
  const primaryBucket = classifyCycleFailReason(primaryReason);

  // Stage 2: class-aware recovery.
  // apply_miss: stage-1 already ran applyOrGroundedRepair (det + LLM). A full
  // same-model re-emit caused hotspot thrash (120b2044: 45 nested loops) without
  // making agents more capable. Skip that re-emit; allow one failover model below.
  // json_parse / no_hunks / schema: envelope repair still helps format recovery.
  let repairResult: WorkerAttemptResult;
  if (primaryBucket === "apply_miss") {
    ctx.appendSystem(
      `[execution] ${agent.id} primary failed (${primaryReason}) — ` +
        `apply recovery already tried (deterministic candidates + grounded repair); ` +
        `skipping same-model re-emit (avoids thrash).`,
    );
    // missTerminal already recorded inside tryWorkerPrompt when grounded repair failed.
    repairResult = { outcome: "retry", reason: primaryReason, lastResponse: primaryResult.lastResponse };
  } else {
    ctx.appendSystem(
      `[execution] ${agent.id} primary failed (${primaryReason}) — trying JSON/envelope repair prompt.`,
    );
    repairResult = await tryWorkerPrompt(
      agent,
      todo,
      expectedFiles,
      state,
      fsAdapter,
      gitAdapter,
      ctx,
      {
        repairFrom:
          primaryResult.lastResponse && primaryReason
            ? { previousResponse: primaryResult.lastResponse, parseError: primaryReason }
            : undefined,
      },
    );
  }
  if (!isWorkerRetry(repairResult)) return repairResult;
  const repairReason = summarizeWorkerFailureReason(repairResult.reason);

  // Stage 3: Failover model once (different model — not same-model double emit).
  // Still useful for apply_miss when another model anchors better; not a deadloop.
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
