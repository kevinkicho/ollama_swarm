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
export { validateProposedHunksStructural } from "./hunkStructuralValidate.js";
import { validateProposedHunksStructural } from "./hunkStructuralValidate.js";

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

/**
 * Best-effort apply of pending-commit hunks on user-stop so ready work
 * (e.g. 3d0aceba t6 DataProvider fix) is not abandoned mid-flight.
 * Structural gate still applies; no LLM review (time-boxed stop path).
 */
export async function drainPendingCommitsOnStop(ctx: {
  boardListTodos: () => Todo[];
  getActive: () => { autoApprove?: boolean; localPath?: string; runId?: string } | undefined;
  appendSystem: (msg: string) => void;
  wrappers: {
    approveCommitQ: (id: string) => void;
    rejectCommitQ: (id: string, reason: string) => void;
  };
  applyHunksAndCommit?: (
    hunks: readonly unknown[],
    files: readonly string[],
    message: string,
    options?: { skipCommit?: boolean },
  ) => Promise<{ ok: boolean; reason?: string; filesWritten?: string[] }>;
}): Promise<void> {
  const pending = ctx.boardListTodos().filter((t) => t.status === "pending-commit");
  if (pending.length === 0) return;
  ctx.appendSystem(
    `[stop-drain] Applying ${pending.length} pending-commit todo(s) before hard stop…`,
  );
  const applyFn = ctx.applyHunksAndCommit;
  if (!applyFn) {
    ctx.appendSystem("[stop-drain] no apply fn — leaving pending-commit as-is");
    return;
  }
  let applied = 0;
  for (const todo of pending) {
    const hunks = (todo as { proposedHunks?: unknown[] }).proposedHunks ?? [];
    const files =
      (todo as { proposedFiles?: string[] }).proposedFiles ?? todo.expectedFiles ?? [];
    if (!hunks.length || !files.length) {
      try {
        ctx.wrappers.rejectCommitQ(todo.id, "stop-drain: no hunks/files");
      } catch { /* */ }
      continue;
    }
    const structural = validateProposedHunksStructural(hunks as Record<string, unknown>[]);
    if (!structural.ok) {
      try {
        ctx.wrappers.rejectCommitQ(todo.id, `stop-drain structural: ${structural.reason}`);
      } catch { /* */ }
      ctx.appendSystem(
        `[stop-drain] skipped ${todo.id.slice(0, 8)}: ${structural.reason}`,
      );
      continue;
    }
    try {
      const {
        isWorkingTreeProposal,
        commitWorkingTreeFiles,
        workingTreeFilesFromHunks,
        workingTreeMessageFromHunks,
      } = await import("./workingTreeCommit.js");
      let res: { ok: boolean; reason?: string };
      if (isWorkingTreeProposal(hunks)) {
        const clonePath = ctx.getActive()?.localPath ?? "";
        const { realFilesystemAdapter, realGitAdapter } = await import("./v2Adapters.js");
        const wt = await commitWorkingTreeFiles({
          todoId: todo.id,
          workerId: "stop-drain",
          files: workingTreeFilesFromHunks(hunks, files),
          message: workingTreeMessageFromHunks(
            hunks,
            `[stop-drain] ${todo.description.slice(0, 80)}`,
          ),
          fs: realFilesystemAdapter(clonePath),
          git: realGitAdapter(clonePath),
          clonePath,
          runId: ctx.getActive()?.runId,
          skipCommit: false,
        });
        res = { ok: wt.ok, reason: wt.ok ? undefined : wt.reason };
      } else {
        res = await applyFn(
          hunks,
          files,
          `[stop-drain] ${todo.description.slice(0, 80)}`,
          { skipCommit: false },
        );
      }
      if (res.ok) {
        try {
          ctx.wrappers.approveCommitQ(todo.id);
        } catch { /* already applied */ }
        applied += 1;
        ctx.appendSystem(`[stop-drain] ✓ applied ${todo.id.slice(0, 8)}`);
      } else {
        try {
          ctx.wrappers.rejectCommitQ(todo.id, `stop-drain apply failed: ${res.reason ?? "unknown"}`);
        } catch { /* */ }
        ctx.appendSystem(
          `[stop-drain] ✗ ${todo.id.slice(0, 8)}: ${res.reason ?? "apply failed"}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`[stop-drain] ✗ ${todo.id.slice(0, 8)}: ${msg.slice(0, 160)}`);
    }
  }
  ctx.appendSystem(`[stop-drain] done — applied ${applied}/${pending.length}`);
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

  const autoApprove = !!ctx.getActive()?.autoApprove;
  ctx.appendSystem(
    autoApprove
      ? `[auditor-gate] Auto-approve mode: accepting ${pendingTodos.length} pending commit(s) without LLM review.`
      : `[auditor-gate] Reviewing ${pendingTodos.length} pending commit(s)...`,
  );

  const approved: Array<{ todo: Todo; hunks: any[]; files: string[]; message: string }> = [];

  for (const todo of pendingTodos) {
    if (ctx.getStopping()) return;

    const hunks = (todo as any).proposedHunks ?? [];
    const files = (todo as any).proposedFiles ?? todo.expectedFiles;

    // explicit hunk review step (skipped under autoApprove)
    let approval = { approve: true, reason: autoApprove ? "autoApprove mode" : "" };
    if (!autoApprove && hunks.length > 0 && files.length > 0 && auditorAgent) {
      try {
        approval = await reviewProposedHunks(ctx, auditorAgent, todo, hunks as any, files);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.appendSystem(`[auditor-gate] hunk review prompt failed: ${msg}`);
        approval = { approve: false, reason: msg };
      }
    }

    // Even under autoApprove: structural/syntax gate. 3d0aceba shipped
    // broken SEARCH_INDEX (orphan comma) and `<component />` instead of
    // `<Component />` because autoApprove skipped LLM review entirely.
    if (approval.approve && hunks.length > 0) {
      const structural = validateProposedHunksStructural(hunks as any[]);
      if (!structural.ok) {
        approval = { approve: false, reason: structural.reason };
        ctx.appendSystem(
          `[auditor-gate] structural reject for ${todo.id.slice(0, 8)}: ${structural.reason}`,
        );
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
          validationReason: approval.reason || (autoApprove ? "autoApprove mode" : "Auditor approved proposed hunks"),
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
    // Git-native working_tree proposals: files already on disk — commit only, no re-apply.
    let batchOk = true;
    const batchFailReasons: string[] = [];
    const failedTodoIds: string[] = [];
    const filesWritten: string[] = [];
    const applyFn = ctx.applyHunksAndCommit;
    for (let i = 0; i < approved.length; i++) {
      const item = approved[i];
      if (!applyFn) {
        // Fallback should not happen; ctx always provides it
        batchOk = false;
        const reason = "no apply fn in auditor ctx";
        batchFailReasons.push(reason);
        failedTodoIds.push(item.todo.id);
        ctx.wrappers.rejectCommitQ(item.todo.id, reason);
        continue;
      }
      try {
        const {
          isWorkingTreeProposal,
          commitWorkingTreeFiles,
          workingTreeFilesFromHunks,
          workingTreeMessageFromHunks,
        } = await import("./workingTreeCommit.js");
        let res: { ok: boolean; reason?: string; filesWritten?: string[] };
        if (isWorkingTreeProposal(item.hunks)) {
          const clonePath = ctx.getActive()?.localPath ?? "";
          const { realFilesystemAdapter, realGitAdapter } = await import("./v2Adapters.js");
          const wtFiles = workingTreeFilesFromHunks(item.hunks, item.files);
          const wtMsg = workingTreeMessageFromHunks(item.hunks, item.message);
          const wt = await commitWorkingTreeFiles({
            todoId: item.todo.id,
            workerId: "auditor",
            files: wtFiles,
            message: wtMsg,
            fs: realFilesystemAdapter(clonePath),
            git: realGitAdapter(clonePath),
            clonePath,
            runId: ctx.getActive()?.runId,
            // Batch path: one finalizeAuditorBatchCommit after all todos.
            skipCommit: true,
          });
          res = {
            ok: wt.ok,
            reason: wt.ok ? undefined : wt.reason,
            filesWritten: wt.ok ? wt.filesWritten : undefined,
          };
          if (wt.ok) {
            ctx.appendSystem(
              `[auditor-gate] git-native working-tree accept ${item.todo.id.slice(0, 8)} ` +
                `(${wt.filesWritten.length} file(s) already on disk)`,
            );
          }
        } else {
          res = await applyFn(item.hunks, item.files, item.message, { skipCommit: true });
        }
        // RR-A: one grounded repair attempt via shared core when apply fails.
        // Skip for working_tree — there are no search/replace hunks to repair.
        if (!res.ok && item.hunks?.length > 0 && !isWorkingTreeProposal(item.hunks)) {
          try {
            const { applyOrGroundedRepair } = await import("../applyOrGroundedRepair.js");
            const { realFilesystemAdapter } = await import("./v2Adapters.js");
            const clonePath = ctx.getActive()?.localPath ?? "";
            const fsAdapter = realFilesystemAdapter(clonePath);
            const texts: Record<string, string | null> = {};
            for (const f of item.files ?? []) {
              try {
                texts[f] = await fsAdapter.read(f);
              } catch {
                texts[f] = null;
              }
            }
            const repair = await applyOrGroundedRepair({
              hunks: item.hunks,
              currentTextsByFile: texts,
              expectedFiles: item.files ?? [],
              readFile: (p) => fsAdapter.read(p),
              callModel: async (prompt) => {
                const auditor = ctx.getAuditor();
                if (!auditor) {
                  throw new Error("no auditor agent for grounded repair");
                }
                const { EMIT_ONLY_PROFILE_ID } = await import(
                  "@ollama-swarm/shared/toolProfiles"
                );
                const { response } = await ctx.promptPlannerSafely(
                  auditor,
                  `Emit-only hunk repair. Return ONLY a JSON object with a "hunks" array.\n\n${prompt}`,
                  EMIT_ONLY_PROFILE_ID as any,
                  "json",
                );
                return response;
              },
              maxGroundedRepairs: 1,
            });
            if (repair.ok && repair.hunks) {
              res = await applyFn(repair.hunks, item.files, item.message, { skipCommit: true });
              if (res.ok) {
                ctx.appendSystem(
                  `[auditor-gate] grounded repair recovered todo ${item.todo.id.slice(0, 8)}`,
                );
              }
            }
          } catch (repairErr) {
            const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
            ctx.appendSystem(
              `[auditor-gate] grounded repair skipped: ${msg.slice(0, 120)}`,
            );
          }
        }
        if (!res.ok) {
          batchOk = false;
          const reason = res.reason || "apply failed in batch";
          batchFailReasons.push(`${item.todo.id.slice(0, 8)}: ${reason}`);
          failedTodoIds.push(item.todo.id);
          ctx.wrappers.rejectCommitQ(item.todo.id, reason);
        } else if (!res.filesWritten || res.filesWritten.length === 0) {
          // Fail-closed symmetry with WorkerPipeline + council workers:
          // never approve a todo that wrote nothing (even if apply said ok).
          batchOk = false;
          const reason = "apply wrote zero files (no-op) — not a successful commit";
          batchFailReasons.push(`${item.todo.id.slice(0, 8)}: ${reason}`);
          failedTodoIds.push(item.todo.id);
          ctx.wrappers.rejectCommitQ(item.todo.id, reason);
        } else {
          filesWritten.push(...res.filesWritten);
        }
      } catch (e: any) {
        batchOk = false;
        const reason = e?.message || "apply exception";
        batchFailReasons.push(`${item.todo.id.slice(0, 8)}: ${reason}`);
        failedTodoIds.push(item.todo.id);
        ctx.wrappers.rejectCommitQ(item.todo.id, reason);
      }
    }

    if (!batchOk) {
      ctx.appendSystem(`[auditor-gate] ✗ Some applies failed in unified batch path`);
      await dispatchBatchApplyFailBrainOs(ctx, {
        failReasons: batchFailReasons,
        todoIds: failedTodoIds,
        files: [...allFiles],
      });
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
      await dispatchBatchApplyFailBrainOs(ctx, {
        failReasons: [advanceCheck.reason],
        todoIds: [...todoIds],
        files: [...allFiles],
        phase: "batch_advance_reject",
      });
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
        await dispatchBatchApplyFailBrainOs(ctx, {
          failReasons: [`batch commit failed: ${commitRes.reason}`],
          todoIds: [...todoIds],
          files: [...allFiles],
          phase: "batch_commit_fail",
        });
      }
    } else {
      // Best effort revert would be complex here; rely on previous per-apply or git state.
      for (const id of todoIds) {
        ctx.wrappers.rejectCommitQ(id, `verify failed: ${verifyReason}`);
      }
      ctx.appendSystem(`[auditor-gate] ✗ Batch verify failed: ${verifyReason}`);
      await dispatchBatchApplyFailBrainOs(ctx, {
        failReasons: [`verify failed: ${verifyReason}`],
        todoIds: [...todoIds],
        files: [...allFiles],
        phase: "batch_verify_fail",
      });
    }
  }
}

/** Brain OS: recruit a helper after auditor batch apply/commit/verify failures. */
async function dispatchBatchApplyFailBrainOs(
  ctx: AuditorContext,
  opts: {
    failReasons: string[];
    todoIds: string[];
    files: string[];
    phase?: string;
  },
): Promise<void> {
  try {
    const active = ctx.getActive() as
      | {
          autoApprove?: boolean;
          localPath?: string;
          runId?: string;
          brainOs?: boolean | object;
          auditorModel?: string;
          model?: string;
        }
      | undefined;
    const { createRunBrainOs, dispatchBrainOsConflict, resolveBrainOsConfig } = await import(
      "../brainOs/adapter.js"
    );
    const bcfg = resolveBrainOsConfig({
      autoApprove: active?.autoApprove,
      brainOs: active?.brainOs as boolean | undefined,
    });
    if (!bcfg.enabled || !active?.localPath || !active?.runId) return;

    ctx.appendSystem(
      `[auditor-gate] [brain-os] batch apply fail — recruiting helper (${opts.failReasons.length} reason(s))`,
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
            ctx.wrappers.proposeCommitQ(id, hunks, files);
          } catch {
            /* todo may not be in-progress */
          }
        },
        reopenTodo: (id, reason) => {
          try {
            // reject already reopened to pending; log only
            ctx.appendSystem(`[brain-os] reopen requested for ${id.slice(0, 8)}: ${reason ?? ""}`);
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
        kind: "apply_miss",
        clonePath: active.localPath,
        privileges: active.autoApprove ? "runner" : "repairer",
        todoId: opts.todoIds[0],
        lastErrors: opts.failReasons.slice(0, 12),
        relevantFiles: opts.files.slice(0, 24),
        autoApprove: active.autoApprove,
        helperModel: active.auditorModel ?? active.model,
        phase: opts.phase ?? "batch_apply_fail",
      },
      {
        appendSystem: (t) => ctx.appendSystem(t),
      },
    );
    ctx.appendSystem(
      `[auditor-gate] [brain-os] batch apply_miss: ${r.status} — ${r.summary.slice(0, 200)}`,
    );
  } catch (err) {
    ctx.appendSystem(
      `[auditor-gate] [brain-os] batch fail dispatch error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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

  const { isWorkingTreeProposal, workingTreeFilesFromHunks, workingTreeMessageFromHunks } =
    await import("./workingTreeCommit.js");
  const gitNative = isWorkingTreeProposal(hunks as unknown[]);
  let gitContext = "";
  if (gitNative) {
    const clonePath = ctx.getActive()?.localPath?.trim() ?? "";
    const wtFiles = workingTreeFilesFromHunks(hunks as unknown[], files);
    const wtMsg = workingTreeMessageFromHunks(
      hunks as unknown[],
      todo.description.slice(0, 120),
    );
    if (clonePath) {
      try {
        const { gitStatusTool, gitDiffTool } = await import("../../tools/nativeToolHandlers.js");
        const st = await gitStatusTool(clonePath);
        const df = await gitDiffTool(clonePath, {});
        const stText = st.ok ? st.output.slice(0, 4_000) : `error: ${st.error}`;
        const dfText = df.ok ? df.output.slice(0, 12_000) : `error: ${df.error}`;
        gitContext = [
          `Mode: git-native working tree (worker already wrote files via tools).`,
          `Proposed commit message: ${wtMsg}`,
          `Files claimed: ${wtFiles.join(", ")}`,
          `git status:`,
          stText || "(clean)",
          `git diff (excerpt):`,
          dfText || "(empty)",
        ].join("\n");
      } catch (err) {
        gitContext = `Mode: git-native working tree. (Could not read git: ${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      gitContext = `Mode: git-native working tree. Files: ${wtFiles.join(", ")}. Message: ${wtMsg}`;
    }
  }

  const reviewPrompt = [
    `You are the auditor reviewing a worker's proposed code change.`,
    `Todo ID: ${todo.id}`,
    `Description: ${todo.description}`,
    `Target files: ${files.join(", ")}`,
    ``,
    gitNative
      ? gitContext
      : `Proposed hunks:\n${JSON.stringify(hunks, null, 2)}`,
    ``,
    criterion ? `Related criterion: ${criterion.description}` : "",
    ``,
    gitNative
      ? `Decide whether to allow a git commit of the dirty working tree for this todo.`
      : `Decide whether to allow these exact changes to be committed.`,
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

