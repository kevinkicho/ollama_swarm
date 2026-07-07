import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, createTimeoutController } from "./councilUtils.js";
import type { ExitContract, ExitCriterion } from "./blackboard/types.js";
import { AUDITOR_SYSTEM_PROMPT, parseAuditorResponse } from "./blackboard/prompts/auditor.js";
import { readDirective, buildDirectiveBlock } from "./directivePromptHelpers.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { windowFileForWorker } from "./blackboard/windowFile.js";
import type { SkipEvidenceTodo } from "./councilSkipReconcile.js";

export interface CouncilAuditorContext {
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void };
  appendSystem: (msg: string) => void;
  stopping: () => boolean;
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
  const agents = ctx.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) {
    return { updatedCriteria: contract.criteria, newTodos: [] };
  }

  const unmetCriteria = contract.criteria.filter(c => c.status === "unmet");
  if (unmetCriteria.length === 0) {
    return { updatedCriteria: contract.criteria, newTodos: [] };
  }

  // Read full file contents for unmet criteria (not just head -100)
  const filesToRead = new Set<string>();
  for (const c of unmetCriteria) {
    for (const f of c.expectedFiles) {
      filesToRead.add(f);
    }
  }

  const fileContents = await readExpectedFiles(cfg.localPath, [...filesToRead]);

  const criteriaBlock = unmetCriteria.map((c) =>
    `  [${c.id}] ${c.description} — files: ${c.expectedFiles.join(", ") || "(none)"}`
  ).join("\n");

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
${committedFiles.map(f => `  ${f}`).join("\n")}
${skipBlock}
For each unmet criterion, determine if it is now MET, WONT-DO, or still UNMET.
- MET: the expected files exist and contain real implementation (not mock/placeholder). When a criterion lists multiple path variants for the same file (e.g. docs/foo.md and foo.md), MET if ANY listed file satisfies the criterion.
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

  try {
    const { controller, cleanup } = createTimeoutController();
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager: ctx.manager as any,
        agentName: "swarm-read",
        signal: controller.signal,
      }, cfg.providerFailover);
      const text = extractProviderText(raw);
      if (!text) {
        ctx.appendSystem("[audit] Empty auditor response — falling back to file check.");
        return fallbackAudit(cfg, contract);
      }

      const parsed = parseAuditorResponse(text);
      if (!parsed.ok) {
        ctx.appendSystem(`[audit] Parse failed: ${parsed.reason} — falling back to file check.`);
        return fallbackAudit(cfg, contract);
      }

      const criteriaById = new Map(contract.criteria.map(c => [c.id, c]));
      const newTodos: Array<{ description: string; expectedFiles: string[]; criterionId?: string }> = [];

      for (const v of parsed.result.verdicts) {
        const crit = criteriaById.get(v.id);
        if (!crit || crit.status !== "unmet") continue;
        if (v.status === "unmet" && v.todos && v.todos.length > 0) {
          newTodos.push(...v.todos.map((t) => ({ ...t, criterionId: v.id })));
        }
      }

      const updatedCriteria = contract.criteria.map((c) => {
        const verdict = parsed.result.verdicts.find((v) => v.id === c.id);
        if (!verdict || c.status !== "unmet") return c;
        return { ...c, status: verdict.status as ExitCriterion["status"], rationale: verdict.rationale };
      });

      const metCount = updatedCriteria.filter(c => c.status === "met").length;
      ctx.appendSystem(`[audit] LLM audit: ${metCount}/${updatedCriteria.length} criteria met, ${newTodos.length} new todo(s).`);

      return { updatedCriteria, newTodos };
    } finally {
      cleanup();
    }
  } catch (err) {
    ctx.appendSystem(`[audit] LLM audit failed: ${err instanceof Error ? err.message : String(err)} — falling back to file check.`);
    return fallbackAudit(cfg, contract);
  }
}

async function fallbackAudit(
  cfg: RunConfig,
  contract: ExitContract,
): Promise<{
  updatedCriteria: ExitCriterion[];
  newTodos: Array<{ description: string; expectedFiles: string[] }>;
}> {
  const updatedCriteria: ExitCriterion[] = [];
  const newTodos: Array<{ description: string; expectedFiles: string[] }> = [];

  for (const c of contract.criteria) {
    if (c.status === "wont-do") {
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
        return lower.includes("todo") || lower.includes("placeholder") || lower.includes("mock") || lower.includes("fixme") || content.trim().length < 20;
      });

      if (hasPlaceholder) {
        updatedCriteria.push(c);
        newTodos.push({ description: c.description, expectedFiles: c.expectedFiles });
      } else {
        updatedCriteria.push({ ...c, status: "met" });
      }
    } else {
      updatedCriteria.push(c);
      newTodos.push({ description: c.description, expectedFiles: c.expectedFiles });
    }
  }

  return { updatedCriteria, newTodos };
}
