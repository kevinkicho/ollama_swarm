// Extracted from BlackboardRunner.ts — auditor orchestration subsystem.
// Manages the auditor prompt cycle and applies the verdict to the contract.
// Takes a narrow context object instead of referencing `this.*`.

import type { Agent } from "../../services/AgentManager.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { ExitContract, ExitCriterion, Todo } from "./types.js";
import type { SwarmEvent } from "../../types.js";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorUserPrompt,
  buildAuditorRepairPrompt,
  parseAuditorResponse,
  type AuditorResult,
  type AuditorSeed,
} from "./prompts/auditor.js";

export type { AuditorResult };
import {
  AUDITOR_VERDICT_JSON_SCHEMA,
} from "./prompts/jsonSchemas.js";
import { buildAuditorSeed } from "./auditorSeedBuilder.js";
import { runDebateAudit } from "./debateAuditor.js";
import { withSiblingRetry } from "./siblingRetry.js";

import { AuditorResponseSchema } from "./prompts/auditor.js";
import { resolveToolProfile } from "../toolProfiles.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";
import {
  buildHunkReviewRepairPrompt,
  parseHunkReviewResponse,
} from "./prompts/hunkReview.js";
import { runParseSalvage } from "./parseSalvage.js";
import type { AgentAssistKind } from "./runnerUtil.js";

export interface AuditorContext {
  getContract: () => ExitContract | undefined;
  getAuditInvocations: () => number;
  incrementAuditInvocations: () => void;
  getMaxAuditInvocations: () => number;
  getAuditor: () => Agent | undefined;
  getStopping: () => boolean;
  boardListTodos: () => Todo[];
  getFindingsList: () => readonly { id: string; agentId: string; text: string; createdAt: number }[];
  readExpectedFiles: (paths: string[]) => Promise<Record<string, string | null>>;
  getActive: () => { 
    uiUrl?: string; 
    model?: string; 
    localPath?: string; 
    rounds?: number; 
    debateAudit?: boolean; 
    debateAuditRounds?: number; 
    userDirective?: string; 
    plannerFallbackModel?: string;
    verifyCommand?: string;
    requireAuditorVerification?: boolean;
    auditorOnlyMutations?: boolean;
  } | undefined;
  cloneContract: (c: ExitContract) => ExitContract;
  emitContractUpdated: (contract: ExitContract) => void;
  appendSystem: (msg: string) => void;
  appendAgent: (
    agent: Agent,
    text: string,
    options?: { assistKind?: AgentAssistKind },
  ) => void;
  emit: (e: SwarmEvent) => void;
  updateAgentModel: (agentId: string, model: string) => void;
  promptPlannerSafely: (agent: Agent, promptText: string, agentName?: import("../../tools/ToolDispatcher.js").ProfileName, ollamaFormat?: "json" | Record<string, unknown>) => Promise<{ response: string; agentUsed: Agent }>;
  wrappers: TodoQueueWrappers;
  allCriteriaResolvedSnapshot: () => boolean;
  v2ObserverApply: (event: any) => void;
  getWorkTranscript: () => readonly import("../../types.js").TranscriptEntry[];
  getAmendments?: () => Array<{ ts: number; text: string }>;
  /** Apply hunks and commit to git. Used by auditor-gated commits.
   *  options.skipCommit: for batching, apply changes but let caller do one git commit.
   */
  applyHunksAndCommit?: (hunks: readonly unknown[], files: readonly string[], message: string, options?: { skipCommit?: boolean }) => Promise<{ ok: boolean; reason?: string; verifyFailed?: boolean; filesWritten?: string[] }>;
}

// ── Audit verification of worker skip reasons ──
// When a worker declines a todo, the auditor can verify whether the
// skip is legitimate or the worker was mistaken/lazy. If the skip is
// invalid, the auditor provides revised instructions for the next worker.

export type SkipVerdict =
  | "valid"
  | "invalid"
  | "hallucinated-todo"
  | "insufficient-tools"
  | "unverified";

export interface SkipVerificationInput {
  todoDescription: string;
  expectedFiles: string[];
  skipReason: string;
  workerIndex: number;
  fileContents: Record<string, string | null>;
  criteriaCount: number;
  /** Tool profile the refusing worker had (e.g. swarm, swarm-builder). */
  workerToolProfile: string;
  /** Tools available to that profile for capability assessment. */
  workerTools: readonly string[];
  todoKind?: "hunks" | "build";
}

export interface SkipVerificationOutput {
  verdict: SkipVerdict;
  rationale: string;
  revisedDescription?: string;
  approachNotes?: string;
  /** When verdict=insufficient-tools, names the missing capability. */
  toolsetGap?: string;
}

const SKIP_VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["valid", "invalid", "hallucinated-todo", "insufficient-tools"],
    },
    rationale: { type: "string", maxLength: 500 },
    revisedDescription: { type: "string", maxLength: 500 },
    approachNotes: { type: "string", maxLength: 800 },
    toolsetGap: { type: "string", maxLength: 300 },
  },
  required: ["verdict", "rationale"],
} as const;

export async function verifyWorkerSkip(
  input: SkipVerificationInput,
  promptAgent: (agent: import("../../services/AgentManager.js").Agent, prompt: string, agentName: ProfileName, formatExpect: "json" | "free") => Promise<string>,
  auditor: import("../../services/AgentManager.js").Agent,
  auditorProfile: ProfileName = "swarm-read",
  appendAgent?: (agent: import("../../services/AgentManager.js").Agent, text: string) => void,
): Promise<SkipVerificationOutput> {
  const filesSection = input.expectedFiles.length > 0
    ? `\nExpected files (current contents):\n${input.expectedFiles.map(f =>
        `  ${f}: ${(input.fileContents[f] ?? "(file not found)").slice(0, 1000)}`
      ).join("\n")}`
    : "\nNo expected files for this todo.";

  const kindNote = input.todoKind === "build"
    ? "This is a BUILD todo (requires shell command execution)."
    : "This is a HUNKS todo (file edits via search/replace).";

  const prompt = `You are the AUDITOR arbitrating a worker's refusal to do a todo. You do NOT do the work yourself — you judge whether the refusal is legitimate and route the outcome.

Todo description: "${input.todoDescription}"
Expected files: ${input.expectedFiles.join(", ") || "(none)"}
Todo kind: ${kindNote}
Worker agent-${input.workerIndex} declined with reason: "${input.skipReason}"
Worker tool profile: ${input.workerToolProfile}
Worker available tools: ${input.workerTools.length > 0 ? input.workerTools.join(", ") : "(none — hunks-only)"}
${filesSection}
Contract criteria count: ${input.criteriaCount}

Evaluate the refusal. Four possible verdicts:

1. **valid** — The worker is right: work is unnecessary, out of scope, or already done. The planner should revise or discard this todo. Return verdict="valid" with rationale for the planner.
2. **invalid** — The worker was mistaken or lazy; the work still needs doing AND the worker's toolset is sufficient. Return verdict="invalid", rationale explaining why work is still required, and optionally revisedDescription + approachNotes for the next worker attempt. The todo goes back on the board — you do not do the work.
3. **hallucinated-todo** — The worker correctly found the TODO premise is false (target content does not exist in the repo). The PLANNER hallucinated. Return verdict="hallucinated-todo" with rationale for the planner to discard or replan.
4. **insufficient-tools** — The work is legitimate but this worker profile CANNOT do it (e.g. hunks worker needs bash, build worker needs web_fetch). Return verdict="insufficient-tools", rationale, and toolsetGap naming the missing tool/capability. This exposes a systemic swarm configuration issue — do NOT route to planner/auditor to do the worker's job.

Respond in JSON: { "verdict": "valid"|"invalid"|"hallucinated-todo"|"insufficient-tools", "rationale": "...", "revisedDescription"?: "...", "approachNotes"?: "...", "toolsetGap"?: "..." }`;

  try {
    const response = await promptAgent(auditor, prompt, auditorProfile, "json");
    appendAgent?.(auditor, response);
    const parsed = JSON.parse(response);
    const verdict: SkipVerdict =
      parsed.verdict === "invalid" ? "invalid"
      : parsed.verdict === "hallucinated-todo" ? "hallucinated-todo"
      : parsed.verdict === "insufficient-tools" ? "insufficient-tools"
      : "valid";
    return {
      verdict,
      rationale: parsed.rationale ?? "Auditor did not provide a rationale.",
      revisedDescription: parsed.revisedDescription || undefined,
      approachNotes: parsed.approachNotes || undefined,
      toolsetGap: parsed.toolsetGap || undefined,
    };
  } catch {
    return {
      verdict: "unverified",
      rationale: "Auditor unavailable — routing to planner for decision.",
    };
  }
}

export async function runAuditor(
  ctx: AuditorContext,
  planner: Agent,
  opts: { allowWhenStopping?: boolean } = {},
): Promise<void> {
  if (!ctx.getContract()) return;
  // Skip audit if all criteria are already resolved — nothing to evaluate.
  const unresolved = ctx.getContract()!.criteria.filter((c) => c.status === "unmet");
  if (unresolved.length === 0) {
    ctx.appendSystem(`Audit skipped — all ${ctx.getContract()!.criteria.length} criteria already resolved (met or wont-do).`);
    return;
  }
  ctx.incrementAuditInvocations();
  const label = opts.allowWhenStopping ? "final audit" : "auditor invocation";
  ctx.appendSystem(
    `${label} ${ctx.getAuditInvocations()}/${ctx.getMaxAuditInvocations()}.`,
  );
  ctx.v2ObserverApply({ type: "auditor-fired", ts: Date.now() });

  const seed = await buildAuditorSeed({
    contract: ctx.getContract()!,
    todos: ctx.boardListTodos(),
    findings: ctx.getFindingsList(),
    readExpectedFiles: (paths) => ctx.readExpectedFiles(paths),
    auditInvocation: ctx.getAuditInvocations(),
    maxInvocations: ctx.getMaxAuditInvocations(),
    uiUrl: ctx.getActive()?.uiUrl,
    model: ctx.getActive()?.model ?? "glm-5.1:cloud",
    clonePath: ctx.getActive()?.localPath ?? "",
    appendSystem: (text) => ctx.appendSystem(text),
  });
  const active = ctx.getActive();
  if (active?.debateAudit) {
    await runDebateAuditPath(ctx, planner, ctx.getContract()!, opts);
    return;
  }

  const auditPrimary = ctx.getAuditor() ?? planner;
  const modelAtEntry = auditPrimary.model;
  const auditorProfile = resolveToolProfile("auditor", ctx.getActive());
  const { response: firstResponse, agentUsed: auditAgent } = await ctx.promptPlannerSafely(
    auditPrimary,
    `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorUserPrompt(seed, auditPrimary.model)}`,
    auditorProfile,
    AUDITOR_VERDICT_JSON_SCHEMA,
  );
  if (ctx.getStopping() && !opts.allowWhenStopping) return;
  ctx.appendAgent(auditAgent, firstResponse);

  let parsed = parseAuditorResponse(firstResponse);
  if (!parsed.ok) {
    ctx.appendSystem(
      `Auditor response did not parse (${parsed.reason}). Issuing repair prompt.`,
    );
    const { response: repairResponse, agentUsed: repairAgent } = await ctx.promptPlannerSafely(
      auditAgent,
      `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorRepairPrompt(firstResponse, parsed.reason)}`,
      auditorProfile,
      AUDITOR_VERDICT_JSON_SCHEMA,
    );
    if (ctx.getStopping() && !opts.allowWhenStopping) return;
    ctx.appendAgent(repairAgent, repairResponse);
    parsed = parseAuditorResponse(repairResponse);
    if (!parsed.ok && (!ctx.getStopping() || opts.allowWhenStopping)) {
      const salvageAgent = ctx.getAuditor() ?? auditAgent;
      ctx.appendSystem(
        `Auditor repair failed (${parsed.reason}); attempting JSON salvage before sibling retry.`,
      );
      const salvage = await runParseSalvage(
        salvageAgent,
        {
          getStopping: ctx.getStopping,
          appendSystem: ctx.appendSystem,
          appendAgent: (a, t, o) => ctx.appendAgent(a, t, o),
          promptPlannerSafely: ctx.promptPlannerSafely,
          getActive: ctx.getActive,
          jsonSchema: AUDITOR_VERDICT_JSON_SCHEMA,
        },
        {
          kind: "auditor",
          parseError: parsed.reason,
          rawOutput: repairResponse,
          attempt: ctx.getAuditInvocations(),
        },
      );
      if (salvage) {
        parsed = parseAuditorResponse(salvage.json);
        if (parsed.ok) {
          ctx.appendSystem(`Auditor JSON salvage succeeded on invocation ${ctx.getAuditInvocations()}.`);
        }
      }
    }
    if (!parsed.ok) {
      const retried = await withSiblingRetry(
        {
          agent: auditAgent,
          modelAtEntry,
          logPrefix: `[${auditAgent.id}]`,
          updateAgentModel: ctx.updateAgentModel,
          emit: ctx.emit as any,
          getFallbackModel: () => ctx.getActive()?.plannerFallbackModel,
          reason: "sibling-retry: auditor JSON parse failed after repair",
        },
        async () => {
          await runAuditor(ctx, planner, opts);
        },
      );
      if (retried) return;
      ctx.appendSystem(
        `Auditor still invalid after repair (${parsed.reason}). Skipping this round; unresolved criteria remain.`,
      );
      return;
    }
  }

  if (parsed.dropped.length > 0) {
    ctx.appendSystem(
      `Auditor dropped ${parsed.dropped.length} invalid item(s): ${parsed.dropped
        .map((d) => d.reason)
        .join(" | ")}`,
    );
  }

  const newTodosCount = parsed.result.verdicts.reduce(
    (n, v) => n + (v.status === "unmet" ? v.todos.length : 0),
    0,
  );
  // Auditor-gated commits: review pending changes before applying verdicts
  await reviewPendingCommits(ctx, auditAgent);
  applyAuditorResult(ctx, parsed.result, planner);
  ctx.v2ObserverApply({
    type: "auditor-returned",
    ts: Date.now(),
    allCriteriaResolved: ctx.allCriteriaResolvedSnapshot(),
    newTodosCount,
  });
}

async function runDebateAuditPath(
  ctx: AuditorContext,
  planner: Agent,
  contract: ExitContract,
  opts: { allowWhenStopping?: boolean },
): Promise<void> {
  const active = ctx.getActive();
  const auditor = ctx.getAuditor() ?? planner;
  const workTranscript = ctx.getWorkTranscript();
  const maxRounds = active?.debateAuditRounds ?? 1;
  const unmetCriteria = contract.criteria.filter(c => c.status === "unmet");

  if (unmetCriteria.length === 0) {
    ctx.appendSystem("[Debate audit] No unmet criteria to debate.");
    ctx.v2ObserverApply({ type: "auditor-returned", ts: Date.now(), allCriteriaResolved: true, newTodosCount: 0 });
    return;
  }

  ctx.appendSystem(`[Debate audit] Debating ${unmetCriteria.length} unmet criterion/criteria (max ${maxRounds} round(s) each).`);

  let totalNewTodos = 0;

  for (const criterion of unmetCriteria) {
    if (ctx.getStopping() && !opts.allowWhenStopping) return;

    const debateExtras = resolveBlackboardPromptExtras({
      active: active as import("../SwarmRunner.js").RunConfig | undefined,
      getAmendments: ctx.getAmendments,
      transcript: workTranscript,
      forAgentId: auditor.id,
    });
    const result = await runDebateAudit({
      pro: auditor,
      con: auditor,
      judge: auditor,
      criterion,
      workTranscript,
      userDirective: debateExtras.effectiveDirective ?? active?.userDirective,
      ctx,
      maxRounds,
    });

    if (result.verdict.winner === "pro" && result.verdict.confidence !== "low") {
      criterion.status = "met";
      criterion.rationale = `Debate audit: PRO won (${result.verdict.confidence} confidence). ${result.proEvidence.slice(0, 200)}`;
    } else if (result.verdict.winner === "con" && result.verdict.confidence !== "low") {
      if (result.verdict.nextAction === "retry") {
        criterion.rationale = `Debate audit: CON won (${result.verdict.confidence} confidence), recommending retry. ${result.conEvidence.slice(0, 200)}`;
      } else if (result.verdict.nextAction === "replan") {
        ctx.wrappers.postTodoQ({
          description: `Replan for criterion ${criterion.id}: ${criterion.description}`,
          expectedFiles: [...criterion.expectedFiles],
          createdBy: planner.id,
          createdAt: Date.now(),
          criterionId: criterion.id,
        });
        totalNewTodos++;
        criterion.rationale = `Debate audit: CON won (${result.verdict.confidence} confidence), new todo posted. ${result.conEvidence.slice(0, 200)}`;
      }
    }
  }

  ctx.emitContractUpdated(ctx.cloneContract(contract));
  const resolved = contract.criteria.filter(c => c.status === "met" || c.status === "wont-do").length;
  ctx.appendSystem(
    `[Debate audit] Complete. ${resolved}/${contract.criteria.length} criteria resolved, ${totalNewTodos} new todo(s).`,
  );
  ctx.v2ObserverApply({
    type: "auditor-returned",
    ts: Date.now(),
    allCriteriaResolved: ctx.allCriteriaResolvedSnapshot(),
    newTodosCount: totalNewTodos,
  });
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
      continue;
    }

    if (hunks.length > 0 && files.length > 0) {
      approved.push({
        todo,
        hunks: hunks as any[],
        files: files as string[],
        message: `[auditor-approved] ${todo.description.slice(0, 80)}`,
      });
    } else {
      ctx.wrappers.rejectCommitQ(todo.id, "No valid hunks or files proposed");
      ctx.appendSystem(`[auditor-gate] ✗ Rejected commit for ${todo.id.slice(0, 8)}: no valid hunks`);
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
          ctx.wrappers.rejectCommitQ(item.todo.id, res.reason || 'apply failed in batch');
        } else if (res.filesWritten) {
          filesWritten.push(...(res.filesWritten || []));
        }
      } catch (e: any) {
        batchOk = false;
        ctx.wrappers.rejectCommitQ(item.todo.id, e?.message || 'apply exception');
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

/** Skip non-terminal todos for a criterion before posting a revised plan.
 *  Prevents orphaned in-progress claims (e.g. rejected t1 blocking drain
 *  while t2–tN sit in pending-commit). */
function supersedeCriterionTodos(
  ctx: AuditorContext,
  criterionId: string,
  reason: string,
): number {
  let skipped = 0;
  for (const todo of ctx.boardListTodos()) {
    if (todo.criterionId !== criterionId) continue;
    if (todo.status === "committed" || todo.status === "skipped") continue;
    ctx.wrappers.skipTodoQ(todo.id, reason);
    skipped++;
  }
  return skipped;
}

export function applyAuditorResult(
  ctx: AuditorContext,
  result: AuditorResult,
  planner: Agent,
): void {
  const contract = ctx.getContract();
  if (!contract) return;
  const criteriaById = new Map(contract.criteria.map((c) => [c.id, c]));
  const now = Date.now();
  let statusChanges = 0;
  let todosPosted = 0;
  let superseded = 0;

  for (const v of result.verdicts) {
    const crit = criteriaById.get(v.id);
    if (!crit) {
      ctx.appendSystem(
        `Auditor emitted verdict for unknown criterion '${v.id}' — ignored.`,
      );
      continue;
    }
    if (crit.status !== "unmet") {
      continue;
    }

    if (v.status === "unmet") {
      if (v.todos.length === 0) {
        crit.status = "wont-do";
        crit.rationale = `auto-converted: auditor returned unmet with no todos. Original rationale: ${v.rationale}`;
        statusChanges++;
        continue;
      }
      if (v.todos.length > 0) {
        superseded += supersedeCriterionTodos(
          ctx,
          crit.id,
          `Superseded — auditor revised plan for ${crit.id}`,
        );
      }
      for (const t of v.todos) {
        ctx.wrappers.postTodoQ({
          description: t.description,
          expectedFiles: [...t.expectedFiles],
          createdBy: planner.id,
          createdAt: now,
          criterionId: crit.id,
          expectedAnchors: (t as { expectedAnchors?: string[] }).expectedAnchors,
        });
        todosPosted++;
      }
      crit.rationale = v.rationale;
    } else {
      crit.status = v.status;
      crit.rationale = v.rationale;
      statusChanges++;
    }
  }

  let added = 0;
  if (result.newCriteria.length > 0) {
    let nextIdx = contract.criteria.length;
    for (const nc of result.newCriteria) {
      nextIdx++;
      contract.criteria.push({
        id: `c${nextIdx}`,
        description: nc.description,
        expectedFiles: [...nc.expectedFiles],
        status: "unmet",
        addedAt: now,
      });
      added++;
    }
  }

  ctx.emitContractUpdated(ctx.cloneContract(contract));
  const supersedeNote = superseded > 0 ? `, ${superseded} superseded todo(s)` : "";
  ctx.appendSystem(
    `Auditor applied: ${statusChanges} status change(s), ${todosPosted} new todo(s), ${added} new criterion(s)${supersedeNote}.`,
  );
}