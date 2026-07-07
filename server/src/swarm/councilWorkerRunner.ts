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
import {
  councilWorkerFallbackModel,
  summarizeWorkerFailureReason,
} from "./councilWorkerFallback.js";
import { TodoQueue, type QueuedTodo } from "./blackboard/TodoQueue.js";
import { scoreCouncilTodoForDequeue } from "./councilTodoPlan.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { checkBuildCommand } from "./blackboard/buildCommandAllowlist.js";
import simpleGit from "simple-git";

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
const WORKER_DEFER_POLL_MS = 750;

/** Dequeue with file-scoped deferral: at most one in-flight writer per expectedFiles path. */
function dequeueCouncilTodo(queue: TodoQueue, workerId: string): QueuedTodo | null {
  const all = queue.list();
  const inProgress = all.filter((t) => t.status === "in-progress");
  const hasPendingOrActiveNonBuild = all.some(
    (t) => (t.status === "pending" || t.status === "in-progress") && t.kind !== "build",
  );

  let best: (typeof all)[number] | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const t of all) {
    if (t.status !== "pending") continue;
    const score = scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore === Number.NEGATIVE_INFINITY) return null;
  return queue.dequeueByScore(workerId, (t) =>
    scoreCouncilTodoForDequeue(t, inProgress, hasPendingOrActiveNonBuild),
  );
}

type TodoExecuteResult =
  | { outcome: "completed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

type WorkerRetryResult = { outcome: "retry"; reason: string };
type WorkerAttemptResult = TodoExecuteResult | WorkerRetryResult;

function isWorkerRetry(r: WorkerAttemptResult): r is WorkerRetryResult {
  return r.outcome === "retry";
}

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
    const todo = dequeueCouncilTodo(state.todoQueue, agent.id);
    if (!todo) {
      if (state.todoQueue.counts().pending === 0) break;
      await new Promise((r) => setTimeout(r, WORKER_DEFER_POLL_MS));
      continue;
    }

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
    const onPromptAbort = () => controller.abort(new Error("user stop"));
    ctx.promptSignal?.addEventListener("abort", onPromptAbort, { once: true });
    try {
      const profile = resolveToolProfile("worker-build", state.cfg);
      const res = await chatOnce(agent, {
        agentName: profile,
        promptText: buildPrompt,
        clonePath: state.clonePath,
        webToolsConfig: state.cfg,
        runId: state.cfg.runId,
        mcpServers: state.cfg.mcpServers,
      });
      const text = extractText(res)?.trim();
      if (text) {
        state.appendAgent(agent, text);
      }
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
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
      return { outcome: "failed", error: "build command produced no file changes" };
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

async function executeTodoWithRetryChain(
  agent: Agent,
  todo: QueuedTodo,
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<TodoExecuteResult> {
  if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };

  if (todo.kind === "build" && todo.command) {
    return executeCouncilBuildTodo(agent, todo, state, gitAdapter, ctx);
  }

  const expectedFiles = [...todo.expectedFiles];

  // Stage 1: Primary prompt
  const primaryResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (!isWorkerRetry(primaryResult)) return primaryResult;
  const primaryReason = summarizeWorkerFailureReason(primaryResult.reason);

  // Stage 2: Repair prompt (same agent, same model)
  ctx.appendSystem(
    `[execution] ${agent.id} primary failed (${primaryReason}) — trying repair prompt.`,
  );
  const repairResult = await tryWorkerPrompt(agent, todo, expectedFiles, state, fsAdapter, gitAdapter, ctx);
  if (!isWorkerRetry(repairResult)) return repairResult;
  const repairReason = summarizeWorkerFailureReason(repairResult.reason);

  // Stage 3: Failover model retry (providerFailover chain or SIBLING_MODELS)
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

async function tryWorkerPrompt(
  agent: Agent,
  todo: QueuedTodo,
  expectedFiles: string[],
  state: CouncilAdapterState,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
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
    if (res === null) {
      return { outcome: "retry", reason: "empty provider response" };
    }

    // Mirror blackboard workerRunner: persist the model JSON so refresh/hydrate
    // can render WorkerHunksBubble (live StreamingDock alone is ephemeral).
    state.appendAgent(agent, res);

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
            state.appendAgent(agent, repairText);
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
      return {
        outcome: "retry",
        reason: applyResult.reason || "hunks could not be applied to the working tree",
      };
    }
    if (!parsed.ok) {
      return { outcome: "retry", reason: parsed.reason };
    }
    if (parsed.ok && parsed.skip) {
      ctx.appendSystem(`[execution] ${agent.id} skipped: ${parsed.skip}`);
      return { outcome: "skipped", reason: parsed.skip };
    }
    if (parsed.ok && parsed.hunks.length === 0) {
      return { outcome: "retry", reason: "worker returned no hunks" };
    }

    return { outcome: "retry", reason: "worker response could not be committed" };
    } finally {
      ctx.promptSignal?.removeEventListener("abort", onPromptAbort);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.stopping()) return { outcome: "skipped", reason: "run stopping" };
    const reason = summarizeWorkerFailureReason(msg);
    ctx.appendSystem(`[execution] ${agent.id} error: ${reason}`);
    return { outcome: "retry", reason: msg };
  }
}
