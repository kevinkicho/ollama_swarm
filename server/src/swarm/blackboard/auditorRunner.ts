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
import {
  tryBrainFallback,
  type BrainFallbackEvent,
} from "./prompts/brainIntegration.js";
import { AuditorResponseSchema } from "./prompts/auditor.js";

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
  appendAgent: (agent: Agent, text: string) => void;
  emit: (e: SwarmEvent) => void;
  updateAgentModel: (agentId: string, model: string) => void;
  promptPlannerSafely: (agent: Agent, promptText: string, agentName?: "swarm" | "swarm-read" | "swarm-builder" | "swarm-research", ollamaFormat?: "json" | Record<string, unknown>) => Promise<{ response: string; agentUsed: Agent }>;
  wrappers: TodoQueueWrappers;
  allCriteriaResolvedSnapshot: () => boolean;
  v2ObserverApply: (event: any) => void;
  getWorkTranscript: () => readonly import("../../types.js").TranscriptEntry[];
  /** Apply hunks and commit to git. Used by auditor-gated commits.
   *  options.skipCommit: for batching, apply changes but let caller do one git commit.
   */
  applyHunksAndCommit?: (hunks: readonly unknown[], files: readonly string[], message: string, options?: { skipCommit?: boolean }) => Promise<{ ok: boolean; reason?: string; verifyFailed?: boolean; filesWritten?: string[] }>;
  /** Brain fallback: prompt an LLM to extract structured JSON from a
   *  failed parse. The promptFn signature matches promptWithFailover. */
  brainPromptFn?: (
    prompt: string,
    model: string,
    maxTokens: number,
    timeoutMs: number,
  ) => Promise<string>;
}

// ── Audit verification of worker skip reasons ──
// When a worker declines a todo, the auditor can verify whether the
// skip is legitimate or the worker was mistaken/lazy. If the skip is
// invalid, the auditor provides revised instructions for the next worker.

export interface SkipVerificationInput {
  todoDescription: string;
  expectedFiles: string[];
  skipReason: string;
  workerIndex: number;
  fileContents: Record<string, string | null>;
  criteriaCount: number;
}

export interface SkipVerificationOutput {
  verdict: "valid" | "invalid" | "hallucinated-todo";
  rationale: string;
  revisedDescription?: string;
  approachNotes?: string;
}

const SKIP_VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["valid", "invalid", "hallucinated-todo"] },
    rationale: { type: "string", maxLength: 500 },
    revisedDescription: { type: "string", maxLength: 500 },
    approachNotes: { type: "string", maxLength: 800 },
  },
  required: ["verdict", "rationale"],
} as const;

export async function verifyWorkerSkip(
  input: SkipVerificationInput,
  promptAgent: (agent: import("../../services/AgentManager.js").Agent, prompt: string, agentName: "swarm" | "swarm-read" | "swarm-builder" | "swarm-research", formatExpect: "json" | "free") => Promise<string>,
  auditor: import("../../services/AgentManager.js").Agent,
): Promise<SkipVerificationOutput> {
  const filesSection = input.expectedFiles.length > 0
    ? `\nExpected files (current contents):\n${input.expectedFiles.map(f =>
        `  ${f}: ${(input.fileContents[f] ?? "(file not found)").slice(0, 1000)}`
      ).join("\n")}`
    : "\nNo expected files for this todo.";

  const prompt = `You are the AUDITOR verifying a worker's decision to skip a todo.

Todo description: "${input.todoDescription}"
Expected files: ${input.expectedFiles.join(", ") || "(none)"}
Worker agent-${input.workerIndex} declined this todo with reason: "${input.skipReason}"
${filesSection}
Contract criteria count: ${input.criteriaCount}

Evaluate the skip reason. Three possible verdicts:

1. **valid** — The worker is right: the work is genuinely unnecessary, out of scope, or already done. Return verdict="valid" and a brief rationale.
2. **invalid** — The worker was mistaken, lazy, or hallucinated. Return verdict="invalid", rationale explaining why, and optionally revisedDescription + approachNotes for the next worker.
3. **hallucinated-todo** — The worker is right to skip, but the TODO itself was based on a false premise. Specifically: the worker confirmed the target content genuinely DOES NOT EXIST in the expected files (e.g. the worker searched for "duplicate rows" and found none, or looked for "API endpoint X" and it doesn't exist), and the todo description implies it should exist. This means the PLANNER hallucinated content that isn't in the codebase. Return verdict="hallucinated-todo" with rationale explaining what content the planner hallucinated.

Respond in JSON: { "verdict": "valid"|"invalid"|"hallucinated-todo", "rationale": "...", "revisedDescription"?: "...", "approachNotes"?: "..." }`;

  try {
    const response = await promptAgent(auditor, prompt, "swarm-read", "json");
    const parsed = JSON.parse(response);
    const verdict = parsed.verdict === "invalid" ? "invalid"
      : parsed.verdict === "hallucinated-todo" ? "hallucinated-todo"
      : "valid";
    return {
      verdict,
      rationale: parsed.rationale ?? "Auditor did not provide a rationale.",
      revisedDescription: parsed.revisedDescription || undefined,
      approachNotes: parsed.approachNotes || undefined,
    };
  } catch {
    // If auditor fails to respond, default to valid-skip (preserve current behavior).
    return { verdict: "valid", rationale: "Auditor unavailable — skip stands." };
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
  const { response: firstResponse, agentUsed: auditAgent } = await ctx.promptPlannerSafely(
    auditPrimary,
    `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorUserPrompt(seed, auditPrimary.model)}`,
    "swarm-read",
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
      "swarm-read",
      AUDITOR_VERDICT_JSON_SCHEMA,
    );
    if (ctx.getStopping() && !opts.allowWhenStopping) return;
    ctx.appendAgent(repairAgent, repairResponse);
    parsed = parseAuditorResponse(repairResponse);
    if (!parsed.ok) {
      // Brain fallback: try AI-assisted parsing before sibling-retry.
      if (ctx.brainPromptFn) {
        ctx.appendSystem(`Auditor parse still failed after repair — trying brain fallback (${parsed.reason}).`);
        try {
          const brainResult = await tryBrainFallback(
            "auditor",
            firstResponse,
            AuditorResponseSchema,
            ctx.brainPromptFn,
            (e: BrainFallbackEvent) => { ctx.emit({ type: "brain-fallback", ...e }); },
            auditAgent,
          );
          if (brainResult) {
            parsed = { ok: true as const, result: brainResult as AuditorResult, dropped: [] };
            ctx.appendSystem(`Brain fallback succeeded — extracted auditor verdict.`);
          }
        } catch {
          // Brain call failed — fall through to sibling-retry.
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

    const result = await runDebateAudit({
      pro: auditor,
      con: auditor,
      judge: auditor,
      criterion,
      workTranscript,
      userDirective: active?.userDirective,
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

  // FULL IN-MEMORY BATCHING: collect all hunks, apply in memory using pure applyHunks,
  // write the final state once, run verify once, then ONE git commit.
  if (approved.length > 0) {
    ctx.appendSystem(`[auditor-gate] Collecting ${approved.length} approved changes for single in-memory apply + commit...`);

    const { applyHunks } = await import("./applyHunks.js");
    const { realFilesystemAdapter, realGitAdapter } = await import("./v2Adapters.js");
    const clonePath = ctx.getActive()?.localPath ?? "";
    const fs = realFilesystemAdapter(clonePath);
    const git = realGitAdapter(clonePath);

    // Collect unique files and all hunks
    const allFiles = new Set<string>();
    const allHunks: any[] = [];
    const todoMessages: string[] = [];
    const todoIds: string[] = [];

    for (const item of approved) {
      item.files.forEach(f => allFiles.add(f));
      allHunks.push(...item.hunks);
      todoMessages.push(item.message);
      todoIds.push(item.todo.id);
    }

    // Read current contents for all files (in mem)
    const currentTexts: Record<string, string | null> = {};
    for (const file of allFiles) {
      try {
        currentTexts[file] = await fs.read(file);
      } catch {
        currentTexts[file] = null;
      }
    }

    // Pure in-memory apply
    const applied = applyHunks(currentTexts, allHunks as any);
    if (!applied.ok) {
      // Reject all on failure
      for (const id of todoIds) {
        ctx.wrappers.rejectCommitQ(id, `batch apply failed: ${applied.error}`);
      }
      ctx.appendSystem(`[auditor-gate] ✗ Batch apply failed: ${applied.error}`);
      return;
    }

    // Write the final texts (one pass)
    const filesWritten: string[] = [];
    for (const [file, newText] of Object.entries(applied.newTextsByFile)) {
      try {
        await fs.write(file, newText);
        filesWritten.push(file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        for (const id of todoIds) ctx.wrappers.rejectCommitQ(id, `write failed: ${msg}`);
        ctx.appendSystem(`[auditor-gate] ✗ Batch write failed: ${msg}`);
        return;
      }
    }

    // Run verify once for the whole batch if configured
    const verifyCommand = ctx.getActive()?.verifyCommand?.trim();
    const forceVerify = ctx.getActive()?.requireAuditorVerification || ctx.getActive()?.auditorOnlyMutations;
    let verifyOk = true;
    let verifyReason = "";

    if ((verifyCommand && verifyCommand.length > 0) || forceVerify) {
      const verify = (verifyCommand && verifyCommand.length > 0)
        ? (await import("./v2Adapters.js")).realVerifyAdapter(clonePath, verifyCommand)
        : { async run() { return { ok: true }; } };

      const v = await verify.run();
      if (!v.ok) {
        verifyOk = false;
        verifyReason = (v as any).reason || "verify failed";
      }
    }

    if (verifyOk) {
      // ONE git commit for the entire batch
      const batchMessage = `auditor batch approval (one commit):\n${todoMessages.map(m => `- ${m}`).join('\n')}`;
      const commitRes = await git.commitAll(batchMessage, "auditor");
      if (commitRes.ok) {
        for (const id of todoIds) {
          ctx.wrappers.approveCommitQ(id);
        }
        ctx.appendSystem(`[auditor-gate] ✓ Single git commit ${(commitRes as any).sha || 'ok'} for batch of ${approved.length} todos (files: ${filesWritten.length})`);
      } else {
        for (const id of todoIds) {
          ctx.wrappers.rejectCommitQ(id, `batch commit failed: ${(commitRes as any).reason || 'unknown'}`);
        }
        ctx.appendSystem(`[auditor-gate] ✗ Batch commit failed: ${(commitRes as any).reason || 'unknown'}`);
      }
    } else {
      // Revert on verify fail (best effort)
      for (const [file, oldText] of Object.entries(currentTexts)) {
        if (oldText !== null) {
          try { await fs.write(file, oldText); } catch {}
        }
      }
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

  try {
    const { response } = await ctx.promptPlannerSafely(
      auditorAgent,
      reviewPrompt,
      "swarm-read",
      { type: "object", properties: { approve: { type: "boolean" }, reason: { type: "string" } }, required: ["approve", "reason"] }
    );
    const parsed = JSON.parse(response);
    return {
      approve: !!parsed.approve,
      reason: parsed.reason || (parsed.approve ? "Approved by auditor review" : "Rejected by auditor review"),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.appendSystem(`[hunk-review] failed: ${msg}`);
    return { approve: false, reason: "Auditor review failed to parse — rejecting for safety" };
  }
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
  ctx.appendSystem(
    `Auditor applied: ${statusChanges} status change(s), ${todosPosted} new todo(s), ${added} new criterion(s).`,
  );
}