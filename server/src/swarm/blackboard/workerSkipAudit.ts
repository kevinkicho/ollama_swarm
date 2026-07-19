/**
 * Auditor verification of worker skip/decline responses.
 * Extracted from workerRunner.executeWorkerTodo.
 */

import type { Agent } from "../../services/AgentManager.js";
import type { Todo } from "./types.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import { verifyWorkerSkip } from "./auditorRunner.js";
import { profileTools, resolveToolProfile } from "../toolProfiles.js";

export type WorkerSkipOutcome =
  | "released"
  | "skipped"
  | "stale";

export interface WorkerSkipAuditCtx {
  getActive: () => RunConfig | undefined;
  getWrappers: () => TodoQueueWrappers;
  getAuditor: () => Agent | undefined;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
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
  readExpectedFiles: (files: string[]) => Promise<Record<string, string | null>>;
  bumpRejectedAttempts: (agentId: string) => void;
  recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => void;
  recordException: (type: string, agentId: string, todoId?: string, reason?: string) => void;
  workerToolProfile: (kind: "hunk" | "build" | "read") => ProfileName;
}

export async function handleWorkerSkip(
  ctx: WorkerSkipAuditCtx,
  agent: Agent,
  todo: Todo,
  skipReason: string,
): Promise<WorkerSkipOutcome> {
  ctx.appendSystem(`[${agent.id}] [v2] worker declined todo: ${skipReason}`);

  // Deterministic tab inventory gate (1963ce25): refuse "already has tabs"
  // skips when requested topics are missing from disk inventory.
  try {
    const {
      todoLikelyNeedsTabInventory,
      buildTabInventories,
      tabSkipContradictsInventory,
    } = await import("./tabInventory.js");
    if (todoLikelyNeedsTabInventory(todo.description, todo.expectedFiles)) {
      const fileContents = await ctx.readExpectedFiles(todo.expectedFiles);
      const inventories = buildTabInventories(fileContents, todo.expectedFiles);
      const check = tabSkipContradictsInventory(
        skipReason,
        todo.description,
        inventories,
      );
      if (check.contradicts) {
        ctx.appendSystem(
          `[${agent.id}] [tab-inventory] override skip — ${check.detail}`,
        );
        ctx.getWrappers().postFindingQ({
          agentId: agent.id,
          text:
            `[tab-inventory] todo ${todo.id.slice(0, 8)} — worker-${agent.index} refused: ` +
            `"${skipReason}" → INVALID (disk missing: ${check.missing.join("; ")}). ${check.detail}`,
          createdAt: Date.now(),
        });
        ctx.getWrappers().releaseTodoQ(
          todo.id,
          `tab-inventory overrode refusal: ${check.detail}`,
        );
        ctx.recordInteraction(
          "auditor_override_refusal",
          todo.id,
          agent.id,
          check.detail,
        );
        ctx.bumpRejectedAttempts(agent.id);
        return "released";
      }
    }
  } catch {
    // fall through to LLM auditor
  }

  const auditor = ctx.getAuditor();
  if (auditor) {
    const workerProfile = ctx.workerToolProfile(todo.kind === "build" ? "build" : "hunk");
    const fileContents = await ctx.readExpectedFiles(todo.expectedFiles);
    const verification = await verifyWorkerSkip(
      {
        todoDescription: todo.description,
        expectedFiles: todo.expectedFiles,
        skipReason,
        workerIndex: agent.index,
        fileContents,
        criteriaCount: ctx.getActive()?.userDirective ? 1 : 0,
        workerToolProfile: workerProfile,
        workerTools: profileTools(workerProfile),
        todoKind: todo.kind,
      },
      ctx.promptAgent,
      auditor,
      resolveToolProfile("auditor", ctx.getActive()),
      ctx.appendAgent,
    );
    const findingPrefix = `[auditor] todo ${todo.id.slice(0, 8)} — worker-${agent.index} refused: "${skipReason}"`;

    if (verification.verdict === "invalid") {
      ctx.appendSystem(
        `Auditor overrode worker-${agent.index}'s refusal: ${verification.rationale}. ` +
          `Todo returns to board for another worker.`,
      );
      ctx.getWrappers().postFindingQ({
        agentId: auditor.id,
        text:
          `${findingPrefix} → INVALID refusal. ${verification.rationale}` +
          (verification.approachNotes ? ` Notes: ${verification.approachNotes}` : ""),
        createdAt: Date.now(),
      });
      if (verification.approachNotes) {
        ctx.appendSystem(`Auditor approach notes: ${verification.approachNotes}`);
      }
      ctx.getWrappers().releaseTodoQ(
        todo.id,
        `auditor overrode refusal: ${verification.rationale}`,
        verification.revisedDescription
          ? { description: verification.revisedDescription }
          : undefined,
      );
      ctx.recordInteraction("auditor_override_refusal", todo.id, auditor.id, verification.rationale);
      ctx.bumpRejectedAttempts(agent.id);
      return "released";
    }

    if (verification.verdict === "insufficient-tools") {
      const gap = verification.toolsetGap ?? "unknown capability";
      ctx.appendSystem(
        `SYSTEMIC TOOLSET GAP on todo ${todo.id.slice(0, 8)}: ${verification.rationale} ` +
          `(missing: ${gap}). Work cannot proceed with current worker profiles.`,
      );
      ctx.getWrappers().postFindingQ({
        agentId: auditor.id,
        text: `${findingPrefix} → INSUFFICIENT TOOLS (${gap}). ${verification.rationale}`,
        createdAt: Date.now(),
      });
      ctx.getWrappers().skipTodoQ(
        todo.id,
        `insufficient-tools: ${gap} — ${verification.rationale}`,
      );
      ctx.recordException(
        "insufficient_tools",
        agent.id,
        todo.id,
        `${gap}: ${verification.rationale}`,
      );
      ctx.recordInteraction("toolset_gap", todo.id, auditor.id, gap);
      return "skipped";
    }

    if (verification.verdict === "hallucinated-todo") {
      ctx.appendSystem(
        `Auditor: todo ${todo.id.slice(0, 8)} is a PLANNER HALLUCINATION — ${verification.rationale}. ` +
          `Routing to planner for discard/revise.`,
      );
      ctx.getWrappers().postFindingQ({
        agentId: auditor.id,
        text: `${findingPrefix} → HALLUCINATED TODO. ${verification.rationale}`,
        createdAt: Date.now(),
      });
      ctx.getWrappers().failTodoQ(
        todo.id,
        `auditor: planner hallucination — ${verification.rationale}`,
        "declined",
      );
      ctx.bumpRejectedAttempts(agent.id);
      ctx.recordInteraction("hallucinated_todo", todo.id, auditor.id, verification.rationale);
      return "stale";
    }

    if (verification.verdict === "valid" || verification.verdict === "unverified") {
      const label = verification.verdict === "valid" ? "VALID refusal" : "UNVERIFIED refusal";
      // Brain OS: on UNVERIFIED declines, recruit a helper before hard fail (4bd7f7f6 thrash).
      if (verification.verdict === "unverified") {
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
              `[${agent.id}] [brain-os] UNVERIFIED decline — recruiting helper before fail`,
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
                kind: "worker_decline",
                clonePath: active.localPath,
                privileges: active.autoApprove ? "board_officer" : "repairer",
                todoId: todo.id,
                lastErrors: [skipReason, verification.rationale],
                relevantFiles: [...todo.expectedFiles],
                autoApprove: active.autoApprove,
                helperModel: active.auditorModel ?? active.model,
              },
              {
                appendSystem: (t) => ctx.appendSystem(t),
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
                `[${agent.id}] [brain-os] worker_decline handled: ${r.summary.slice(0, 200)}`,
              );
              ctx.recordInteraction(
                "brain_os_decline",
                todo.id,
                agent.id,
                r.summary.slice(0, 200),
              );
              // Prefer skip so the board can replan rather than thrash the same decline.
              try {
                ctx.getWrappers().skipTodoQ(
                  todo.id,
                  `brain-os: ${r.summary.slice(0, 200)} (worker: ${skipReason})`,
                );
              } catch {
                ctx.getWrappers().failTodoQ(
                  todo.id,
                  `brain-os partial: ${r.summary.slice(0, 200)}`,
                  "declined",
                );
              }
              return "skipped";
            }
          }
        } catch (err) {
          ctx.appendSystem(
            `[${agent.id}] [brain-os] worker_decline dispatch error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      ctx.appendSystem(`Auditor: ${label} — ${verification.rationale}. Routing to planner.`);
      ctx.getWrappers().postFindingQ({
        agentId: auditor.id,
        text: `${findingPrefix} → ${label}. ${verification.rationale}`,
        createdAt: Date.now(),
      });
      ctx.getWrappers().failTodoQ(
        todo.id,
        `auditor: ${label.toLowerCase()} — ${verification.rationale} (worker: ${skipReason})`,
        "declined",
      );
      ctx.bumpRejectedAttempts(agent.id);
      ctx.recordException("worker_declined", agent.id, todo.id, skipReason);
      ctx.recordInteraction("worker_skip", todo.id, agent.id, skipReason);
      return "stale";
    }
  }

  ctx.getWrappers().failTodoQ(todo.id, `[v2] worker declined: ${skipReason}`, "declined");
  ctx.bumpRejectedAttempts(agent.id);
  ctx.recordException("worker_declined", agent.id, todo.id, skipReason);
  ctx.recordInteraction("worker_skip", todo.id, agent.id, skipReason);
  return "stale";
}
