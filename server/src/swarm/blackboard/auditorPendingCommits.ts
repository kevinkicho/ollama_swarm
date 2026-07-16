// Auditor pending-commit review + hunk review — extracted from auditorRunner.ts.

import type { Agent } from "../../services/AgentManager.js";
import type { ExitContract, Todo } from "./types.js";
import type { AuditorContext } from "./auditorRunner.js";
import { resolveToolProfile } from "../toolProfiles.js";
import { runParseSalvage } from "./parseSalvage.js";
import {
  parseHunkReviewResponse,
  buildHunkReviewRepairPrompt,
} from "./prompts/hunkReview.js";
import {
  recordDeliberationAsync,
  type DeliberationSink,
} from "../deliberation/deliberationLog.js";

function deliberationSink(ctx: AuditorContext): DeliberationSink {
  return {
    clonePath: ctx.getActive()?.localPath,
    runId: ctx.getActive()?.runId,
    appendSystem: (m) => ctx.appendSystem(m),
    emit: (e) => ctx.emit(e as any),
  };
}

/** Reject auditor batches that wrote no files or touch no unmet criterion paths. */
export function batchAdvancesUnmetCriteria(
  contract: ExitContract | undefined,
  filesWritten: readonly string[],
  batchFileSet: ReadonlySet<string>,
): { ok: boolean; reason: string } {
  if (filesWritten.length === 0) {
    return { ok: false, reason: "batch apply wrote zero files" };
  }
  const unmet = (contract?.criteria ?? []).filter((c) => c.status === "unmet");
  if (unmet.length === 0) return { ok: true, reason: "" };

  const expected = new Set<string>();
  for (const c of unmet) {
    for (const f of c.expectedFiles ?? []) expected.add(f);
  }
  if (expected.size === 0) return { ok: true, reason: "" };

  const touched = new Set([...filesWritten, ...batchFileSet]);
  for (const f of touched) {
    if (expected.has(f)) return { ok: true, reason: "" };
  }
  return {
    ok: false,
    reason: `batch touched no unmet criterion expectedFiles (wrote: ${filesWritten.join(", ")})`,
  };
}

/** Review pending-commit todos and approve/reject each one.
 *  Called before applyAuditorResult so the auditor can evaluate
 *  proposed hunks before assessing contract criteria. */
export async function reviewPendingCommits(
  ctx: AuditorContext,
  auditorAgent: Agent,
): Promise<void> {
  const pendingTodos = ctx.boardListTodos().filter((t) => t.status === "pending-commit");
  if (pendingTodos.length === 0) return;

  ctx.appendSystem(`[auditor-gate] Reviewing ${pendingTodos.length} pending commit(s)...`);

  const approved: Array<{ todo: Todo; hunks: any[]; files: string[]; message: string }> = [];

  for (const todo of pendingTodos) {
    if (ctx.getStopping()) return;

    const hunks = (todo as any).proposedHunks ?? [];
    const files = (todo as any).proposedFiles ?? todo.expectedFiles;

    // explicit hunk review step
    let approval = { approve: true, reason: "" };
    if (hunks.length > 0 && files.length > 0 && auditorAgent) {
      try {
        approval = await reviewProposedHunks(ctx, auditorAgent, todo, hunks as any, files);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.appendSystem(`[auditor-gate] hunk review prompt failed: ${msg}`);
        approval = { approve: false, reason: msg };
      }
    }

    if (!approval.approve) {
      ctx.wrappers.rejectCommitQ(todo.id, approval.reason || "Auditor rejected the proposed hunks");
      ctx.appendSystem(`[auditor-gate] ✗ Rejected commit for ${todo.id.slice(0, 8)}: ${approval.reason}`);
      recordDeliberationAsync(
        {
          runId: ctx.getActive()?.runId ?? "unknown",
          layer: "hierarchy",
          preset: "blackboard",
          subject: `commit:${todo.id.slice(0, 8)} ${todo.description.slice(0, 120)}`,
          claim: `Worker proposed ${hunks.length} hunk(s) for ${(files as string[]).slice(0, 4).join(", ")}`,
          proposer: "worker",
          validator: "auditor",
          verdict: "deny",
          validationReason: approval.reason || "Auditor rejected the proposed hunks",
          evidence: Array.isArray(files) ? (files as string[]).slice(0, 12) : [],
          related: { todoId: todo.id },
        },
        deliberationSink(ctx),
      );
      continue;
    }

    if (hunks.length > 0 && files.length > 0) {
      approved.push({
        todo,
        hunks: hunks as any[],
        files: files as string[],
        message: `[auditor-approved] ${todo.description.slice(0, 80)}`,
      });
      recordDeliberationAsync(
        {
          runId: ctx.getActive()?.runId ?? "unknown",
          layer: "hierarchy",
          preset: "blackboard",
          subject: `commit:${todo.id.slice(0, 8)} ${todo.description.slice(0, 120)}`,
          claim: `Worker proposed ${hunks.length} hunk(s) for ${(files as string[]).slice(0, 4).join(", ")}`,
          proposer: "worker",
          validator: "auditor",
          verdict: "approve",
          validationReason: approval.reason || "Auditor approved proposed hunks",
          evidence: (files as string[]).slice(0, 12),
          related: { todoId: todo.id },
        },
        deliberationSink(ctx),
      );
    } else {
      ctx.wrappers.rejectCommitQ(todo.id, "No valid hunks or files proposed");
      ctx.appendSystem(`[auditor-gate] ✗ Rejected commit for ${todo.id.slice(0, 8)}: no valid hunks`);
      recordDeliberationAsync(
        {
          runId: ctx.getActive()?.runId ?? "unknown",
          layer: "hierarchy",
          preset: "blackboard",
          subject: `commit:${todo.id.slice(0, 8)}`,
          claim: "Worker pending-commit without valid hunks/files",
          proposer: "worker",
          validator: "auditor",
          verdict: "deny",
          validationReason: "No valid hunks or files proposed",
          related: { todoId: todo.id },
        },
        deliberationSink(ctx),
      );
    }
  }

  // Use the unified apply path (via ctx wrapper which calls WorkerPipeline.applyAndCommit).
  // This unifies batch with the main apply logic, removes duplication, and honors skipCommit for final single commit.
  if (approved.length > 0) {
    ctx.appendSystem(`[auditor-gate] Collecting ${approved.length} approved changes for unified apply + single commit...`);

    const allHunks: any[] = [];
    const todoMessages: string[] = [];
    const todoIds: string[] = [];
    const allFiles = new Set<string>();

    for (const item of approved) {
      item.files.forEach((f: string) => allFiles.add(f));
      allHunks.push(...item.hunks);
      todoMessages.push(item.message);
      todoIds.push(item.todo.id);
    }

    // Use wrapper for each (supports skipCommit) - this routes through WorkerPipeline for consistency
    // (handles delete, anchors, verify per item if needed, but we batch the final commit).
    let batchOk = true;
    const filesWritten: string[] = [];
    const applyFn = ctx.applyHunksAndCommit;
    for (let i = 0; i < approved.length; i++) {
      const item = approved[i];
      if (!applyFn) {
        // Fallback should not happen; ctx always provides it
        batchOk = false;
        ctx.wrappers.rejectCommitQ(item.todo.id, 'no apply fn in auditor ctx');
        continue;
      }
      try {
        const res = await applyFn(item.hunks, item.files, item.message, { skipCommit: true });
        if (!res.ok) {
          batchOk = false;
          ctx.wrappers.rejectCommitQ(item.todo.id, res.reason || "apply failed in batch");
        } else if (!res.filesWritten || res.filesWritten.length === 0) {
          // Fail-closed symmetry with WorkerPipeline + council workers:
          // never approve a todo that wrote nothing (even if apply said ok).
          batchOk = false;
          ctx.wrappers.rejectCommitQ(
            item.todo.id,
            "apply wrote zero files (no-op) — not a successful commit",
          );
        } else {
          filesWritten.push(...res.filesWritten);
        }
      } catch (e: any) {
        batchOk = false;
        ctx.wrappers.rejectCommitQ(item.todo.id, e?.message || "apply exception");
      }
    }

    if (!batchOk) {
      ctx.appendSystem(`[auditor-gate] ✗ Some applies failed in unified batch path`);
      return;
    }

    const advanceCheck = batchAdvancesUnmetCriteria(
      ctx.getContract(),
      filesWritten,
      allFiles,
    );
    if (!advanceCheck.ok) {
      for (const id of todoIds) {
        ctx.wrappers.rejectCommitQ(id, advanceCheck.reason);
      }
      ctx.appendSystem(`[auditor-gate] ✗ Batch rejected: ${advanceCheck.reason}`);
      return;
    }

    // Run verify once for the batch if configured (centralized)
    const verifyCommand = ctx.getActive()?.verifyCommand?.trim();
    const forceVerify = ctx.getActive()?.requireAuditorVerification || ctx.getActive()?.auditorOnlyMutations;
    let verifyOk = true;
    let verifyReason = "";

    if ((verifyCommand && verifyCommand.length > 0) || forceVerify) {
      const { realVerifyAdapter } = await import("./v2Adapters.js");
      const verify = (verifyCommand && verifyCommand.length > 0)
        ? realVerifyAdapter(ctx.getActive()?.localPath ?? "", verifyCommand)
        : { async run() { return { ok: true }; } };
      const v = await verify.run();
      if (!v.ok) {
        verifyOk = false;
        verifyReason = (v as any).reason || "verify failed";
      }
    }

    if (verifyOk) {
      // Final single commit for the batch (per-todo applies used skipCommit).
      const localPath = ctx.getActive()?.localPath ?? "";
      const batchMessage = `auditor batch approval (one commit):\n${todoMessages.map(m => `- ${m}`).join('\n')}`;
      const { finalizeAuditorBatchCommit } = await import("./v2Adapters.js");
      const commitRes = await finalizeAuditorBatchCommit(localPath, batchMessage);
      if (commitRes.ok) {
        for (const id of todoIds) {
          ctx.wrappers.approveCommitQ(id);
        }
        // Q11: record successful (todo, hunks) for future hunkRag few-shots.
        if (ctx.getActive()?.hunkRag && localPath) {
          try {
            const {
              appendHunkExample,
              serializeHunksForRag,
            } = await import("../hunkRagStore.js");
            const runId = ctx.getActive()?.runId;
            for (const item of approved) {
              if (!item.hunks?.length) continue;
              await appendHunkExample(localPath, {
                todoDescription: item.todo.description,
                expectedFiles: item.files,
                hunkResponse: serializeHunksForRag(item.hunks),
                runId,
                ts: Date.now(),
              });
            }
          } catch {
            // best-effort — never fail the commit path on RAG store errors
          }
        }
        if (commitRes.skippedGit) {
          ctx.appendSystem(
            `[auditor-gate] ✓ Batch applied for ${approved.length} todo(s) (no git repo at ${localPath} — commit skipped)`,
          );
        } else {
          ctx.appendSystem(`[auditor-gate] ✓ Unified batch + single git commit for ${approved.length} todos`);
        }
      } else {
        for (const id of todoIds) {
          ctx.wrappers.rejectCommitQ(id, `batch commit failed: ${commitRes.reason}`);
        }
        ctx.appendSystem(`[auditor-gate] ✗ Batch commit failed: ${commitRes.reason}`);
      }
    } else {
      // Best effort revert would be complex here; rely on previous per-apply or git state.
      for (const id of todoIds) {
        ctx.wrappers.rejectCommitQ(id, `verify failed: ${verifyReason}`);
      }
      ctx.appendSystem(`[auditor-gate] ✗ Batch verify failed: ${verifyReason}`);
    }
  }
}

/**
 * NEW (priority 2): Explicit hunk review step.
 * Prompts the auditor to review the *specific* proposed hunks against the todo
 * and relevant criterion before any mutation is applied.
 * Returns { approve: boolean, reason: string }
 */
export async function reviewProposedHunks(
  ctx: AuditorContext,
  auditorAgent: Agent,
  todo: Todo,
  hunks: readonly any[],
  files: readonly string[],
): Promise<{ approve: boolean; reason: string }> {
  const criterion = (ctx.getContract()?.criteria || []).find(c => 
    files.some(f => (c as any).expectedFiles?.includes?.(f) || (c as any).description?.includes(todo.description))
  );

  const reviewPrompt = [
    `You are the auditor reviewing a worker's proposed code change.`,
    `Todo ID: ${todo.id}`,
    `Description: ${todo.description}`,
    `Target files: ${files.join(", ")}`,
    ``,
    `Proposed hunks:`,
    JSON.stringify(hunks, null, 2),
    ``,
    criterion ? `Related criterion: ${criterion.description}` : "",
    ``,
    `Decide whether to allow these exact changes to be committed.`,
    `Respond with EXACT JSON only:`,
    `{ "approve": true | false, "reason": "<concise 1-2 sentence justification>" }`,
  ].join("\n");

  const auditorProfile = resolveToolProfile("auditor", ctx.getActive());
  const hunkReviewSchema = {
    type: "object",
    properties: { approve: { type: "boolean" }, reason: { type: "string" } },
    required: ["approve", "reason"],
  };

  try {
    const { response: firstResponse } = await ctx.promptPlannerSafely(
      auditorAgent,
      reviewPrompt,
      auditorProfile,
      hunkReviewSchema,
    );
    ctx.appendAgent(auditorAgent, firstResponse);

    let parsed = parseHunkReviewResponse(firstResponse);
    if (!parsed.ok) {
      ctx.appendSystem(
        `[hunk-review] response did not parse (${parsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse } = await ctx.promptPlannerSafely(
        auditorAgent,
        buildHunkReviewRepairPrompt(firstResponse, parsed.reason),
        auditorProfile,
        hunkReviewSchema,
      );
      ctx.appendAgent(auditorAgent, repairResponse);
      parsed = parseHunkReviewResponse(repairResponse);
      if (!parsed.ok && !ctx.getStopping()) {
        ctx.appendSystem(
          `[hunk-review] repair failed (${parsed.reason}); attempting JSON salvage.`,
        );
        const salvage = await runParseSalvage(
          auditorAgent,
          {
            getStopping: ctx.getStopping,
            appendSystem: ctx.appendSystem,
            appendAgent: (a, t, o) => ctx.appendAgent(a, t, o),
            promptPlannerSafely: ctx.promptPlannerSafely,
            getActive: ctx.getActive,
            jsonSchema: hunkReviewSchema,
          },
          {
            kind: "hunk-review",
            parseError: parsed.reason,
            rawOutput: repairResponse,
            attempt: 1,
          },
        );
        if (salvage) {
          parsed = parseHunkReviewResponse(salvage.json);
          if (parsed.ok) {
            ctx.appendSystem(`[hunk-review] auditor salvage succeeded for todo ${todo.id}.`);
          }
        }
      }
      if (!parsed.ok) {
        ctx.appendSystem(
          `[hunk-review] still invalid after repair (${parsed.reason}) — rejecting for safety.`,
        );
        return { approve: false, reason: "Auditor review failed to parse — rejecting for safety" };
      }
    }

    return { approve: parsed.approve, reason: parsed.reason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.appendSystem(`[hunk-review] failed: ${msg}`);
    return { approve: false, reason: "Auditor review failed to parse — rejecting for safety" };
  }
}

