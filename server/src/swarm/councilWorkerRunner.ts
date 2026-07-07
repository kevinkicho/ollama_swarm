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
  isLiteratureTodo,
} from "./blackboard/prompts/worker.js";
import { buildResearchToolsNote } from "./blackboard/prompts/planner.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import { isWebToolsEnabled, resolveToolProfile } from "./toolProfiles.js";
import { effectiveToolProfileId } from "../../../shared/src/toolProfiles.js";
import { makeWebToolHandler } from "./toolCallTranscript.js";
import { withSiblingRetry } from "./blackboard/siblingRetry.js";
import { siblingModelFor } from "./blackboard/BlackboardRunnerConstants.js";
import { TodoQueue, type QueuedTodo } from "./blackboard/TodoQueue.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { readExpectedFiles } from "./sharedFileUtils.js";

export interface WorkerRunnerContext {
  appendSystem: (msg: string) => void;
  recordFailure?: (todoId: string, description: string, error: string) => void;
  stopping: () => boolean;
  /** Soft drain: finish the in-flight todo, then exit without dequeuing more. */
  draining?: () => boolean;
  /** Aborted on hard stop so hung prompts fail fast. */
  promptSignal?: AbortSignal;
}

const WORKER_COOLDOWN_MS = 5_000;

type TodoExecuteResult =
  | { outcome: "completed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

async function runCouncilLiteratureResearch(
  state: CouncilAdapterState,
  agent: Agent,
  todo: QueuedTodo,
  appendSystem: (msg: string) => void,
): Promise<string | undefined> {
  const cfg = state.cfg;
  if (!isWebToolsEnabled(cfg) || !isLiteratureTodo(todo.description)) {
    return undefined;
  }
  const profile = resolveToolProfile("read", cfg);
  const prompt = [
    "You are a research worker gathering sources BEFORE writing file edits.",
    buildResearchToolsNote(true),
    "",
    `TODO: ${todo.description}`,
    `Target files: ${todo.expectedFiles.join(", ")}`,
    cfg.userDirective ? `User directive: ${cfg.userDirective}` : "",
    "",
    "Use web_search and web_fetch to gather citable findings. Output plain prose with bullet points and URLs.",
    "Do NOT emit JSON hunks in this phase.",
  ].filter(Boolean).join("\n");

  try {
    const res = await chatOnce(agent, {
      agentName: profile,
      promptText: prompt,
      clonePath: state.clonePath,
      webToolsConfig: cfg,
      runId: cfg.runId,
      mcpServers: cfg.mcpServers,
      onTool: makeWebToolHandler(appendSystem, agent.id),
    });
    const text = extractText(res)?.trim();
    if (text && text.length >= 80) {
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
      appendSystem(`[${agent.id}] Literature research: captured ${capped.length} chars of notes.`);
      return capped;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendSystem(`[${agent.id}] Literature research failed: ${msg}`);
  }
  return undefined;
}

function setWorkerThinking(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "thinking", { thinkingSince: Date.now() });
}

function setWorkerReady(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
}

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
    if (ctx.draining?.()) break;
    const todo = state.todoQueue.dequeue(agent.id);
    if (!todo) break;

    setWorkerThinking(state, agent);
    ctx.appendSystem(`[execution] ${agent.id} working on: ${todo.description.slice(0, 120)}...`);

    let result: TodoExecuteResult;
    try {
      result = await executeTodoWithRetryChain(agent, todo, state, fsAdapter, gitAdapter, ctx);
    } finally {
      setWorkerReady(state, agent);
    }
    if (result.outcome === "completed") {
      state.todoQueue.complete(todo.id);
      completed++;
      await new Promise((r) => setTimeout(r, WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500)));
    } else if (result.outcome === "skipped") {
      state.todoQueue.skip(todo.id, result.reason);
      skipped++;
    } else {
      state.todoQueue.fail(todo.id, result.error);
      failed++;
      ctx.recordFailure?.(todo.id, todo.description, result.error.slice(0, 200));
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
): Promise<TodoExecuteResult> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
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
  let siblingResult: TodoExecuteResult | "retry" = "retry";
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

  return { outcome: "failed", error: "all retries exhausted" };
}

async function tryWorkerPrompt(
  agent: Agent,
  todo: QueuedTodo,
  expectedFiles: string[],
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<TodoExecuteResult | "retry"> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
  // Re-read file contents fresh each attempt (avoids stale content on retry)
  const fileContents = await readExpectedFiles(state.clonePath, expectedFiles);

  const allExist = expectedFiles.length > 0 && expectedFiles.every((f) => fileContents[f] !== null);
  let adjustedDesc = todo.description;
  if (allExist) {
    adjustedDesc = `${todo.description}\n\nIMPORTANT: The file(s) already exist. Use op "replace" or "append" — do NOT use op "create".`;
  }

  const webToolsEnabled = isWebToolsEnabled(state.cfg);
  const researchNotes = await runCouncilLiteratureResearch(
    state,
    agent,
    todo,
    ctx.appendSystem,
  );
  const workerProfile = effectiveToolProfileId("swarm-builder", state.cfg);

  const basePrompt = `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt({
    todoId: todo.id,
    description: adjustedDesc,
    expectedFiles,
    fileContents,
    directive: state.cfg.userDirective,
    webToolsEnabled,
    researchNotes,
  })}`;

  try {
    const controller = new AbortController();
    const onPromptAbort = () => controller.abort(new Error("user stop"));
    ctx.promptSignal?.addEventListener("abort", onPromptAbort, { once: true });
    try {
    const raw = await promptWithFailoverAuto(agent, basePrompt, {
      manager: state.manager as any,
      agentName: workerProfile,
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
        return { outcome: "completed" };
      }

      // Apply failed — try hunk repair
      if (applyResult.reason.includes("search") && applyResult.reason.includes("not found")) {
        const failedFile = applyResult.reason.match(/file "([^"]+)"/)?.[1];
        const currentContent = failedFile ? fileContents[failedFile] : null;
        if (currentContent && fixedHunks.length > 0) {
          const repairPrompt = buildHunkRepairPrompt(fixedHunks, applyResult.reason, { [failedFile!]: currentContent });
          const repairRaw = await promptWithFailoverAuto(agent, `${WORKER_SYSTEM_PROMPT}\n\n${repairPrompt}`, {
            manager: state.manager as any,
            agentName: workerProfile,
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
                return { outcome: "completed" };
              }
            }
          }
        }
      }
    } else if (parsed.ok && parsed.skip) {
      ctx.appendSystem(`[execution] ${agent.id} skipped: ${parsed.skip}`);
      return { outcome: "skipped", reason: parsed.skip };
    }

    return "retry";
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
    ctx.appendSystem(`[execution] ${agent.id} error: ${msg.slice(0, 300)}`);
    return "retry";
  }
}
