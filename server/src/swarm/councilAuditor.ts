import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, createTimeoutController } from "./councilUtils.js";
import type { ExitContract, ExitCriterion } from "./blackboard/types.js";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorRepairPrompt,
  parseAuditorResponse,
} from "./blackboard/prompts/auditor.js";
import { readDirective, buildDirectiveBlock } from "./directivePromptHelpers.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { windowFileForWorker } from "./blackboard/windowFile.js";
import type { SkipEvidenceTodo } from "./councilSkipReconcile.js";
import {
  filterAuditTodosAgainstSkips,
  promoteCriteriaFromSkipEvidence,
} from "./councilSkipReconcile.js";
import type { CouncilProgressLedger } from "./councilProgressLedger.js";
import { fallbackMayMarkMet } from "./councilLedgerReconcile.js";

export interface CouncilAuditorContext {
  manager: {
    list: () => Agent[];
    markStatus: (id: string, status: string) => void;
    recordPromptComplete: (id: string, data: any) => void;
  };
  appendSystem: (msg: string) => void;
  stopping: () => boolean;
  /** User stop/drain — aborts an in-flight audit prompt. */
  abortSignal?: AbortSignal;
  ledger?: CouncilProgressLedger;
}

async function promptAuditor(
  lead: Agent,
  prompt: string,
  cfg: RunConfig,
  ctx: CouncilAuditorContext,
  signal: AbortSignal,
): Promise<string | null> {
  const raw = await promptWithFailoverAuto(
    lead,
    prompt,
    {
      manager: ctx.manager as any,
      agentName: "swarm-read",
      signal,
    },
    cfg.providerFailover,
  );
  return extractProviderText(raw);
}

function applyAuditorVerdicts(
  contract: ExitContract,
  verdicts: ReturnType<typeof parseAuditorResponse> & { ok: true },
  skipEvidence: readonly SkipEvidenceTodo[],
): {
  updatedCriteria: ExitCriterion[];
  newTodos: Array<{ description: string; expectedFiles: string[]; criterionId?: string }>;
} {
  const criteriaById = new Map(contract.criteria.map((c) => [c.id, c]));
  let newTodos: Array<{ description: string; expectedFiles: string[]; criterionId?: string }> = [];

  for (const v of verdicts.result.verdicts) {
    const crit = criteriaById.get(v.id);
    if (!crit || crit.status !== "unmet") continue;
    if (v.status === "unmet" && v.todos && v.todos.length > 0) {
      newTodos.push(...v.todos.map((t) => ({ ...t, criterionId: v.id })));
    }
  }

  let updatedCriteria = contract.criteria.map((c) => {
    const verdict = verdicts.result.verdicts.find((v) => v.id === c.id);
    if (!verdict || c.status !== "unmet") return c;
    return { ...c, status: verdict.status as ExitCriterion["status"], rationale: verdict.rationale };
  });

  updatedCriteria = promoteCriteriaFromSkipEvidence(updatedCriteria, skipEvidence);
  newTodos = filterAuditTodosAgainstSkips(newTodos, skipEvidence);
  const metIds = new Set(updatedCriteria.filter((c) => c.status === "met").map((c) => c.id));
  newTodos = newTodos.filter((t) => !t.criterionId || !metIds.has(t.criterionId));

  return { updatedCriteria, newTodos };
}

export async function runCouncilLlmAudit(
  cfg: RunConfig,
  contract: ExitContract,
  committedFiles: string[],
  ctx: CouncilAuditorContext,
  skipEvidence: readonly SkipEvidenceTodo[] = [],
): Promise<{
  updatedCriteria: ExitCriterion[];
  newTodos: Array<{ description: string; expectedFiles: string[]; criterionId?: string }>;
}> {
  if (ctx.stopping()) {
    return { updatedCriteria: contract.criteria, newTodos: [] };
  }

  const agents = ctx.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) {
    return { updatedCriteria: contract.criteria, newTodos: [] };
  }

  const unmetCriteria = contract.criteria.filter((c) => c.status === "unmet");
  if (unmetCriteria.length === 0) {
    return { updatedCriteria: contract.criteria, newTodos: [] };
  }

  const filesToRead = new Set<string>();
  for (const c of unmetCriteria) {
    for (const f of c.expectedFiles) {
      filesToRead.add(f);
    }
  }

  const fileContents = await readExpectedFiles(cfg.localPath, [...filesToRead]);

  const criteriaBlock = unmetCriteria
    .map(
      (c) =>
        `  [${c.id}] ${c.description} — files: ${c.expectedFiles.join(", ") || "(none)"}`,
    )
    .join("\n");

  const fileBlock = Object.entries(fileContents)
    .filter(([_, content]) => content !== null)
    .map(([path, content]) => {
      const view = windowFileForWorker(content ?? "");
      const sizeNote = view.full ? "" : ` (${view.originalLength} chars total)`;
      return `--- ${path}${sizeNote} ---\n${view.content}`;
    })
    .join("\n\n");

  const dirCtx = readDirective({ userDirective: cfg.userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, { authoritative: true }).join("\n");

  const skipBlock =
    skipEvidence.length > 0
      ? `\nWorker skip evidence (workers declined todos citing work already done):\n${skipEvidence
          .map(
            (s) =>
              `  - "${s.reason ?? "(no reason)"}" — files: ${s.expectedFiles.join(", ") || "(none)"}${s.criterionId ? ` [criterion ${s.criterionId}]` : ""}`,
          )
          .join("\n")}\n`
      : "";

  const prompt = `${AUDITOR_SYSTEM_PROMPT}\n\nYou are auditing a council's work.

${directiveBlock}

Unmet criteria to evaluate:
${criteriaBlock}

Current file contents:
${fileBlock || "(no files to read)"}

Already committed files:
${committedFiles.map((f) => `  ${f}`).join("\n")}
${skipBlock}
For each unmet criterion, determine if it is now MET, WONT-DO, or still UNMET.
- MET: the expected files exist and contain real implementation (not mock/placeholder). When a criterion lists multiple path variants for the same file (e.g. docs/foo.md and foo.md), MET if ANY listed file satisfies the criterion.
- When worker skip evidence shows work is already done for a criterion's files, prefer MET unless file contents clearly contradict the skip reason.
- WONT-DO: the criterion is impossible or no longer relevant
- UNMET: still needs work — provide specific todos

Return ONLY a JSON object:
{
  "verdicts": [
    {
      "id": "criterion-id",
      "status": "met" | "wont-do" | "unmet",
      "rationale": "brief explanation",
      "todos": [{"description": "specific todo", "expectedFiles": ["path/to/file.ts"]}]
    }
  ]
}`;

  const ledger = ctx.ledger;

  try {
    const { controller, cleanup } = createTimeoutController();
    const onExternalAbort = () => controller.abort(new Error("user stop"));
    ctx.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const text = await promptAuditor(lead, prompt, cfg, ctx, controller.signal);
      if (ctx.stopping()) {
        return { updatedCriteria: contract.criteria, newTodos: [] };
      }
      if (!text) {
        ctx.appendSystem("[audit] Empty auditor response — falling back to file check.");
        return fallbackAudit(cfg, contract, skipEvidence, ledger);
      }

      let parsed = parseAuditorResponse(text);
      if (!parsed.ok) {
        ctx.appendSystem(
          `[audit] Parse failed: ${parsed.reason} — issuing repair prompt.`,
        );
        const repairText = await promptAuditor(
          lead,
          `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorRepairPrompt(text, parsed.reason)}`,
          cfg,
          ctx,
          controller.signal,
        );
        if (ctx.stopping()) {
          return { updatedCriteria: contract.criteria, newTodos: [] };
        }
        if (repairText) {
          parsed = parseAuditorResponse(repairText);
        }
      }

      if (!parsed.ok) {
        ctx.appendSystem(
          `[audit] Parse failed after repair: ${parsed.reason} — falling back to file check.`,
        );
        return fallbackAudit(cfg, contract, skipEvidence, ledger);
      }

      const { updatedCriteria, newTodos } = applyAuditorVerdicts(
        contract,
        parsed,
        skipEvidence,
      );

      const metCount = updatedCriteria.filter((c) => c.status === "met").length;
      ctx.appendSystem(
        `[audit] LLM audit: ${metCount}/${updatedCriteria.length} criteria met, ${newTodos.length} new todo(s).`,
      );

      return { updatedCriteria, newTodos };
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onExternalAbort);
      cleanup();
    }
  } catch (err) {
    if (ctx.stopping()) {
      return { updatedCriteria: contract.criteria, newTodos: [] };
    }
    ctx.appendSystem(
      `[audit] LLM audit failed: ${err instanceof Error ? err.message : String(err)} — falling back to file check.`,
    );
    return fallbackAudit(cfg, contract, skipEvidence, ledger);
  }
}

export async function fallbackAudit(
  cfg: RunConfig,
  contract: ExitContract,
  skipEvidence: readonly SkipEvidenceTodo[] = [],
  ledger?: CouncilProgressLedger,
): Promise<{
  updatedCriteria: ExitCriterion[];
  newTodos: Array<{ description: string; expectedFiles: string[] }>;
}> {
  const emptyLedger = ledger ?? {
    schemaVersion: 1 as const,
    runId: "fallback",
    updatedAt: 0,
    lastCycle: 0,
    observations: [],
  };

  const updatedCriteria: ExitCriterion[] = [];
  const newTodos: Array<{ description: string; expectedFiles: string[] }> = [];

  for (const c of contract.criteria) {
    if (c.status === "wont-do") {
      updatedCriteria.push(c);
      continue;
    }
    if (c.status === "met") {
      updatedCriteria.push(c);
      continue;
    }

    const fileContents = await readExpectedFiles(cfg.localPath, c.expectedFiles);
    const existingFiles = c.expectedFiles.filter((f) => fileContents[f] !== null);
    const anyExist = c.expectedFiles.length === 0 || existingFiles.length > 0;

    if (anyExist && existingFiles.length > 0) {
      const hasPlaceholder = existingFiles.some((f) => {
        const content = fileContents[f];
        if (!content) return false;
        const lower = content.toLowerCase();
        return (
          lower.includes("todo") ||
          lower.includes("placeholder") ||
          lower.includes("mock") ||
          lower.includes("fixme") ||
          content.trim().length < 20
        );
      });

      const decision = fallbackMayMarkMet(c, emptyLedger, hasPlaceholder);
      if (decision.met) {
        updatedCriteria.push({ ...c, status: "met", rationale: `Fallback: ${decision.reason}` });
      } else {
        updatedCriteria.push(c);
        newTodos.push({ description: c.description, expectedFiles: c.expectedFiles });
      }
    } else {
      updatedCriteria.push(c);
      newTodos.push({ description: c.description, expectedFiles: c.expectedFiles });
    }
  }

  const reconciled = promoteCriteriaFromSkipEvidence(updatedCriteria, skipEvidence);
  const filteredTodos = filterAuditTodosAgainstSkips(newTodos, skipEvidence);
  const metIds = new Set(reconciled.filter((c) => c.status === "met").map((c) => c.id));
  const finalTodos = filteredTodos.filter((t) => {
    const crit = contract.criteria.find((c) => c.description === t.description);
    return !crit || !metIds.has(crit.id);
  });

  return { updatedCriteria: reconciled, newTodos: finalTodos };
}