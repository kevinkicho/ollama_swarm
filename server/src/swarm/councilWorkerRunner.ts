import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText } from "./councilUtils.js";
import { applyAndCommit } from "./blackboard/WorkerPipeline.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import {
  buildWorkerUserPrompt,
  buildHunkRepairPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
} from "./blackboard/prompts/worker.js";
import { withSiblingRetry } from "./blackboard/siblingRetry.js";
import { siblingModelFor } from "./blackboard/BlackboardRunnerConstants.js";
import { TodoQueue, type QueuedTodo } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { readExpectedFiles } from "./sharedFileUtils.js";

export interface WorkerRunnerContext {
  appendSystem: (msg: string) => void;
  recordFailure?: (todoId: string, description: string, error: string) => void;
  stopping: () => boolean;
}

const WORKER_COOLDOWN_MS = 5_000;

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
    const todo = state.todoQueue.dequeue(agent.id);
    if (!todo) break;

    ctx.appendSystem(`[execution] ${agent.id} working on: ${todo.description.slice(0, 120)}...`);

    const result = await executeTodoWithRetryChain(agent, todo, state, fsAdapter, gitAdapter, ctx);
    if (result === "completed") {
      state.todoQueue.complete(todo.id);
      completed++;
      await new Promise((r) => setTimeout(r, WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500)));
    } else if (result === "skipped") {
      state.todoQueue.skip(todo.id, "worker declined");
      skipped++;
    } else {
      state.todoQueue.fail(todo.id, result);
      failed++;
      ctx.recordFailure?.(todo.id, todo.description, result.slice(0, 200));
    }
  }

  return { completed, failed, skipped };
}

async function executeTodoWithRetryChain(
  agent: Agent,
  todo: QueuedTodo,
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<"completed" | "skipped" | string> {
  const expectedFiles = [...todo.expectedFiles];

  // Stage 1: Primary prompt
  const primaryResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (primaryResult !== "retry") return primaryResult;

  // Stage 2: Repair prompt (same agent, same model)
  ctx.appendSystem(`[execution] ${agent.id} parse failed — trying repair prompt.`);
  const repairResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (repairResult !== "retry") return repairResult;

  // Stage 3: Sibling retry (swap model, re-prompt)
  ctx.appendSystem(`[execution] ${agent.id} repair failed — trying sibling retry.`);
  const modelAtEntry = agent.model;
  let siblingResult: "completed" | "skipped" | "retry" = "retry";
  await withSiblingRetry(
    {
      agent,
      modelAtEntry,
      logPrefix: `[${agent.id}]`,
      updateAgentModel: (id, model) => { agent.model = model; },
      emit: () => {},
      getFallbackModel: () => siblingModelFor(agent.model),
      reason: "sibling-retry: worker failed after repair",
    },
    async () => {
      siblingResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
    },
  );

  if (siblingResult !== "retry") return siblingResult;

  return "all retries exhausted";
}

async function tryWorkerPrompt(
  agent: Agent,
  todo: QueuedTodo,
  expectedFiles: string[],
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<"completed" | "skipped" | "retry"> {
  // Re-read file contents fresh each attempt (avoids stale content on retry)
  const fileContents = await readExpectedFiles(state.clonePath, expectedFiles);

  const allExist = expectedFiles.length > 0 && expectedFiles.every((f) => fileContents[f] !== null);
  let adjustedDesc = todo.description;
  if (allExist) {
    adjustedDesc = `${todo.description}\n\nIMPORTANT: The file(s) already exist. Use op "replace" or "append" — do NOT use op "create".`;
  }

  const basePrompt = `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt({
    todoId: todo.id,
    description: adjustedDesc,
    expectedFiles,
    fileContents,
    directive: state.cfg.userDirective,
  })}`;

  try {
    const controller = new AbortController();
    const raw = await promptWithFailoverAuto(agent, basePrompt, {
      manager: state.manager,
      agentName: "swarm-builder",
      signal: controller.signal,
      intraStreamLoop: true,
    }, state.cfg.providerFailover);

    const res = extractProviderText(raw);
    if (res === null) return "retry";

    const parsed = parseWorkerResponse(res, expectedFiles);
    if (parsed.ok && parsed.hunks.length > 0 && !parsed.skip) {
      const fixedHunks = parsed.hunks.map((h) => {
        if ((h as any).op === "create" && fileContents[(h as any).file] !== null) {
          const currentContent = fileContents[(h as any).file]!;
          return { op: "replace", file: (h as any).file, search: currentContent.slice(0, 2000), replace: (h as any).content } as any;
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
      });

      if (applyResult.ok) {
        ctx.appendSystem(`[execution] ${agent.id} ✓ applied — ${applyResult.commitSha?.slice(0, 7)}.`);
        return "completed";
      }

      // Apply failed — try hunk repair
      if (applyResult.reason.includes("search") && applyResult.reason.includes("not found")) {
        const failedFile = applyResult.reason.match(/file "([^"]+)"/)?.[1];
        const currentContent = failedFile ? fileContents[failedFile] : null;
        if (currentContent && fixedHunks.length > 0) {
          const repairPrompt = buildHunkRepairPrompt(fixedHunks, applyResult.reason, { [failedFile!]: currentContent });
          const repairRaw = await promptWithFailoverAuto(agent, `${WORKER_SYSTEM_PROMPT}\n\n${repairPrompt}`, {
            manager: state.manager,
            agentName: "swarm-builder",
            signal: new AbortController().signal,
          }, state.cfg.providerFailover);
          const repairText = extractProviderText(repairRaw);
          if (repairText) {
            const repairParsed = parseWorkerResponse(repairText, expectedFiles);
            if (repairParsed.ok && repairParsed.hunks.length > 0 && !repairParsed.skip) {
              const repairResult = await applyAndCommit({
                todoId: todo.id,
                workerId: agent.id,
                expectedFiles,
                hunks: repairParsed.hunks,
                fs: fsAdapter,
                git: gitAdapter,
              });
              if (repairResult.ok) {
                ctx.appendSystem(`[execution] ${agent.id} ✓ applied (hunk repair) — ${repairResult.commitSha?.slice(0, 7)}.`);
                return "completed";
              }
            }
          }
        }
      }
    } else if (parsed.ok && parsed.skip) {
      ctx.appendSystem(`[execution] ${agent.id} skipped: ${parsed.skip}`);
      return "skipped";
    }

    return "retry";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[execution] ${agent.id} error: ${msg.slice(0, 300)}`);
    return "retry";
  }
}

async function tryBrainFallbackWorker(
  agent: Agent,
  todo: QueuedTodo,
  expectedFiles: string[],
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<"completed" | "skipped" | "retry"> {
  try {
    const brainPromptFn = async (brainPrompt: string, model: string, maxTokens: number, timeoutMs: number): Promise<string> => {
      const brainAgent: Agent = {
        id: "brain",
        index: -1,
        model,
        port: 0,
        sessionId: "brain",
        status: "idle" as const,
        thinkingSince: undefined,
        lastChunkAt: undefined,
        pid: undefined,
        cwd: "",
      };
      const raw = await promptWithFailoverAuto(brainAgent, brainPrompt, {
        manager: state.manager,
        agentName: "swarm-read",
        signal: new AbortController().signal,
      });
      return extractProviderText(raw) ?? "";
    };

    const brainResult = await tryBrainFallback(
      "worker",
      "prompt",
      WorkerResponseSchema,
      brainPromptFn,
      () => {},
    );

    if (brainResult) {
      return await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
    }

    return "retry";
  } catch {
    return "retry";
  }
}
