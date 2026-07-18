/**
 * Wire Brain OS to a run: chat via chatOnce + board effect hooks.
 */

import type { Agent } from "../../services/AgentManager.js";
import {
  createBrainOsDispatcher,
  type BrainOsConfig,
  type BrainOsDispatcher,
} from "./index.js";
import type { HelperPrivilege, BrainConflictKind } from "@ollama-swarm/shared/brainOs";
import { defaultBrainDispatchBudget } from "@ollama-swarm/shared/brainOs";
import { chatOnce } from "../chatOnce.js";

export interface BrainOsRunHooks {
  appendSystem: (text: string, summary?: import("../../types.js").TranscriptEntrySummary) => void;
  completeTodo?: (todoId: string, reason: string) => void;
  skipTodo?: (todoId: string, reason: string) => void;
  reopenTodo?: (todoId: string, reason?: string) => void;
  proposeHunks?: (todoId: string, hunks: unknown[], files: string[]) => void;
  requestApply?: (todoId?: string) => Promise<void> | void;
  recommendDrain?: () => void;
  recommendStop?: (reason: string) => void;
  getWorkerPool?: () => Agent[];
  /** WS/event hub — emits swarm_control_advice for the resilience chip. */
  emit?: (event: {
    type: "swarm_control_advice";
    ts: number;
    kind: "brain_os";
    source: "brain_os";
    rationale: string;
    conflictKind?: string;
    status?: string;
    agentId?: string;
  }) => void;
}

/** Enable Brain OS for trusted local runs (autoApprove) unless explicitly disabled. */
export function resolveBrainOsConfig(cfg: {
  autoApprove?: boolean;
  brainOs?: BrainOsConfig | boolean;
}): BrainOsConfig {
  if (cfg.brainOs === false) return { enabled: false };
  if (cfg.brainOs === true) return { enabled: true };
  if (cfg.brainOs && typeof cfg.brainOs === "object") {
    return {
      enabled: cfg.brainOs.enabled !== false,
      ...cfg.brainOs,
    };
  }
  // Default: on when autoApprove (user said "let them cook")
  return { enabled: !!cfg.autoApprove };
}

export function createRunBrainOs(
  cfg: { autoApprove?: boolean; brainOs?: BrainOsConfig | boolean; auditorModel?: string; model?: string },
  hooks: BrainOsRunHooks,
): BrainOsDispatcher {
  const resolved = resolveBrainOsConfig(cfg);
  const dispatcher = createBrainOsDispatcher({
    ...resolved,
    helperModel: resolved.helperModel ?? cfg.auditorModel ?? cfg.model,
  });
  return dispatcher;
}

export async function dispatchBrainOsConflict(
  dispatcher: BrainOsDispatcher,
  opts: {
    runId: string;
    kind: BrainConflictKind;
    clonePath: string;
    privileges: HelperPrivilege;
    todoId?: string;
    lastErrors?: string[];
    relevantFiles?: string[];
    boardSnapshot?: {
      pending: number;
      inProgress: number;
      pendingCommit: number;
      completed: number;
      skipped: number;
    };
    autoApprove?: boolean;
    helperModel?: string;
    phase?: string;
    gitDiffExcerpt?: string;
    transcriptExcerpt?: string;
  },
  hooks: BrainOsRunHooks,
): Promise<{ status: string; summary: string }> {
  if (!dispatcher.enabled) {
    return { status: "blocked", summary: "brain OS disabled" };
  }

  const result = await dispatcher.dispatch(
    {
      runId: opts.runId,
      kind: opts.kind,
      clonePath: opts.clonePath,
      privileges: opts.privileges,
      depth: 0,
      helperModel: opts.helperModel,
      budget: defaultBrainDispatchBudget(),
      context: {
        todoId: opts.todoId,
        lastErrors: opts.lastErrors,
        relevantFiles: opts.relevantFiles,
        boardSnapshot: opts.boardSnapshot,
        autoApprove: opts.autoApprove,
        host: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
        phase: opts.phase,
        gitDiffExcerpt: opts.gitDiffExcerpt,
        transcriptExcerpt: opts.transcriptExcerpt,
      },
    },
    {
      chat: async (c) => {
        const agent = {
          id: c.agentId,
          model: c.model,
          index: 0,
          cwd: c.clonePath,
        } as Agent;
        const result = await chatOnce(agent, {
          agentName: "swarm-auto",
          promptText: `${c.system}\n\n---\n\n${c.user}`,
          maxToolTurns: c.maxToolTurns,
          clonePath: c.clonePath,
          webToolsConfig: { autoApprove: true, webTools: true },
          signal: c.signal,
          activity: {
            kind: "brain-os",
            label: `helper ${c.agentId}`,
          },
        });
        const parts = result?.data?.parts ?? [];
        return parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      },
      log: (msg, summary) => hooks.appendSystem(msg, summary),
      effectDeps: {
        appendSystem: (t) => hooks.appendSystem(t),
        completeTodo: hooks.completeTodo,
        skipTodo: hooks.skipTodo,
        reopenTodo: hooks.reopenTodo,
        proposeHunks: hooks.proposeHunks,
        requestApply: hooks.requestApply,
        recommendDrain: hooks.recommendDrain,
        recommendStop: hooks.recommendStop,
      },
    },
  );

  // Surface on the resilience control plane (chip + history hydrate).
  try {
    hooks.emit?.({
      type: "swarm_control_advice",
      ts: Date.now(),
      kind: "brain_os",
      source: "brain_os",
      conflictKind: opts.kind,
      status: result.status,
      rationale: result.summary.slice(0, 500),
    });
  } catch {
    /* optional */
  }

  return { status: result.status, summary: result.summary };
}
