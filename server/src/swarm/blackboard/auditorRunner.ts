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
import { runParseSalvage } from "./parseSalvage.js";
import type { AgentAssistKind } from "./runnerUtil.js";
import { reviewPendingCommits } from "./auditorPendingCommits.js";

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
// Pending-commit review lives in auditorPendingCommits.ts
export {
  batchAdvancesUnmetCriteria,
  reviewPendingCommits,
  reviewProposedHunks,
} from "./auditorPendingCommits.js";

export { runAuditor } from "./auditorRunCore.js";
