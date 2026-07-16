/**
 * Build-todo path: allowlisted bash command → git commit.
 * Extracted from workerRunner.ts.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo } from "./types.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import { checkBuildCommand } from "./buildCommandAllowlist.js";
import { resolveToolProfile } from "../toolProfiles.js";

export interface BuildTodoCtx {
  getActive: () => RunConfig | undefined;
  getWrappers: () => TodoQueueWrappers;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { role?: "worker" | "general" },
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
  gitStatus: (clonePath: string) => Promise<{ porcelain: string; changedFiles: number }>;
  commitAll: (clonePath: string, message: string) => Promise<void>;
  maybeSettleHypothesisGroup: (todoId: string) => void;
}

function workerToolProfile(ctx: BuildTodoCtx, kind: "hunk" | "build" | "read"): ProfileName {
  const cfg = ctx.getActive();
  if (kind === "build") return resolveToolProfile("worker-build", cfg);
  if (kind === "read") return resolveToolProfile("read", cfg);
  return resolveToolProfile("worker", cfg);
}

export async function executeBuildTodo(
  ctx: BuildTodoCtx,
  agent: Agent,
  todo: Todo,
): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> {
  if (!todo.command || todo.command.trim().length === 0) {
    ctx.appendSystem(`[${agent.id}] build TODO ${todo.id.slice(0, 8)} has no command — marking stale.`);
    ctx.getWrappers().failTodoQ(todo.id, "build TODO missing command field");
    return "stale";
  }

  const check = checkBuildCommand(todo.command);
  if (!check.ok) {
    ctx.appendSystem(
      `[${agent.id}] build TODO ${todo.id.slice(0, 8)} command refused by allowlist: ${check.reason}`,
    );
    ctx.getWrappers().failTodoQ(todo.id, `build command not allowed: ${check.reason}`);
    return "stale";
  }
  ctx.appendSystem(
    `[${agent.id}] running build command for todo ${todo.id.slice(0, 8)}: \`${todo.command}\` (binary: ${check.binary})`,
  );

  const clonePath = ctx.getActive()?.localPath;
  if (!clonePath) {
    ctx.getWrappers().failTodoQ(todo.id, "no localPath — runner state corrupt");
    return "stale";
  }

  const buildPrompt = [
    "You are a build worker. Your job is to run ONE shell command via the bash tool.",
    "",
    `Command to run: ${todo.command}`,
    `Working directory: ${clonePath}`,
    "",
    "Steps:",
    "1. Invoke the bash tool with the EXACT command above. Do not modify, prefix, or chain.",
    "2. After the command completes, respond with this JSON envelope and NOTHING ELSE:",
    `   {"ok": true|false, "exitCode": <number>, "summary": "<one-line summary of what changed>"}`,
    "",
    "If the command exits non-zero, set ok=false. Do not edit files manually — bash side effects are the entire delivery mechanism.",
  ].join("\n");

  let response: string;
  try {
    response = await ctx.promptAgent(agent, buildPrompt, workerToolProfile(ctx, "build"), "json", "json");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] build prompt failed: ${msg.slice(0, 120)}`);
    ctx.getWrappers().failTodoQ(todo.id, `build prompt failed: ${msg.slice(0, 200)}`);
    return "stale";
  }
  ctx.appendAgent(agent, response, { role: "worker" });

  const dirty = await ctx.gitStatus(clonePath);
  if (!dirty.changedFiles || dirty.changedFiles === 0) {
    ctx.appendSystem(
      `[${agent.id}] build command ran but working tree is clean — marking todo stale.`,
    );
    ctx.getWrappers().failTodoQ(todo.id, "build command produced no file changes");
    return "stale";
  }

  try {
    await ctx.commitAll(clonePath, `build: ${todo.description.slice(0, 80)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[${agent.id}] git commit failed: ${msg.slice(0, 120)}`);
    ctx.getWrappers().failTodoQ(todo.id, `git commit failed: ${msg.slice(0, 200)}`);
    return "stale";
  }

  ctx.getWrappers().completeTodoQ(todo.id);
  ctx.maybeSettleHypothesisGroup(todo.id);
  ctx.appendSystem(
    `[${agent.id}] ✓ build commit landed for todo ${todo.id.slice(0, 8)} (${dirty.changedFiles} file change(s))`,
  );
  return "committed";
}
