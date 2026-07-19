// Core auditor prompt cycle + debate audit path — extracted from auditorRunner.ts.

import type { Agent } from "../../services/AgentManager.js";
import type { ExitContract } from "./types.js";
import type { AuditorContext } from "./auditorRunner.js";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorUserPrompt,
  buildAuditorRepairPrompt,
  parseAuditorResponse,
} from "./prompts/auditor.js";
import { AUDITOR_VERDICT_JSON_SCHEMA } from "./prompts/jsonSchemas.js";
import { buildAuditorSeed } from "./auditorSeedBuilder.js";
import { runDebateAudit } from "./debateAuditor.js";
import { withSiblingRetry } from "./siblingRetry.js";
import { resolveToolProfile } from "../toolProfiles.js";
import { runParseSalvage } from "./parseSalvage.js";
import { reviewPendingCommits } from "./auditorPendingCommits.js";
import { resolveBlackboardPromptExtras } from "./blackboardPromptContext.js";

export async function runAuditor(
  ctx: AuditorContext,
  planner: Agent,
  opts: { allowWhenStopping?: boolean } = {},
): Promise<void> {
  const auditPrimaryEarly = ctx.getAuditor() ?? planner;

  // Pending-commit review is independent of the criteria-verdict LLM.
  // Live blackboard no-progress (11b4e505, 4bd7f7f6, 72f72773, 5a33a5f7):
  // workers left many pending-commit todos; auditor think-only / prompt-
  // too-long threw *before* reviewPendingCommits → zero commits for 3
  // cycles → no-productive-progress stop. Drain the gate first.
  try {
    await reviewPendingCommits(ctx, auditPrimaryEarly);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendSystem(`[auditor-gate] pending-commit review failed early: ${msg}`);
  }
  if (ctx.getStopping() && !opts.allowWhenStopping) return;

  if (!ctx.getContract()) return;
  // Skip criteria LLM if all criteria are already resolved.
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

  const auditPrimary = auditPrimaryEarly;
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
  // Pending commits already reviewed at entry; re-check for any mid-audit arrivals.
  await reviewPendingCommits(ctx, auditAgent);
  // Dynamic import avoids circular load with auditorRunner re-exporting this module.
  const { applyAuditorResult } = await import("./auditorRunner.js");
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

