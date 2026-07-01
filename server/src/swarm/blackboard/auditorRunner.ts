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
  getActive: () => { uiUrl?: string; model?: string; localPath?: string; rounds?: number; debateAudit?: boolean; debateAuditRounds?: number; userDirective?: string; plannerFallbackModel?: string } | undefined;
  cloneContract: (c: ExitContract) => ExitContract;
  emitContractUpdated: (contract: ExitContract) => void;
  appendSystem: (msg: string) => void;
  appendAgent: (agent: Agent, text: string) => void;
  emit: (e: SwarmEvent) => void;
  updateAgentModel: (agentId: string, model: string) => void;
  promptPlannerSafely: (agent: Agent, promptText: string, agentName?: "swarm" | "swarm-read" | "swarm-builder", ollamaFormat?: "json" | Record<string, unknown>) => Promise<{ response: string; agentUsed: Agent }>;
  wrappers: TodoQueueWrappers;
  allCriteriaResolvedSnapshot: () => boolean;
  v2ObserverApply: (event: any) => void;
  getWorkTranscript: () => readonly import("../../types.js").TranscriptEntry[];
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
  promptAgent: (agent: import("../../services/AgentManager.js").Agent, prompt: string, agentName: "swarm" | "swarm-read" | "swarm-builder", formatExpect: "json" | "free") => Promise<string>,
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
            firstResponse,
            AuditorResponseSchema,
            "auditor",
            ctx.brainPromptFn,
            (e: BrainFallbackEvent) => { ctx.emit({ type: "brain-fallback", ...e }); },
            auditAgent,
          );
          if (brainResult) {
            parsed = { ok: true as const, result: brainResult, dropped: [] };
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
          emit: ctx.emit,
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