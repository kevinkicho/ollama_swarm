// councilDecisions.ts — Todo extraction for Council preset
// Kept: extractActionableTodos, extractTodosFromAudit
// Removed: Gate 1 (verifyTodo), Gate 3 (resolveContradiction), Gate 4 (recoverDeletedFiles)

import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TranscriptEntry } from "../types.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import {
  extractProviderText,
  createTimeoutController,
  COUNCIL_TODO_EXTRACT_TIMEOUT_MS,
  parseJsonArrayFromResponse,
  gatherProjectContext,
  type RealManager,
} from "./councilUtils.js";
import { classifyExpectedFiles } from "./blackboard/prompts/pathValidation.js";
import { resolveSafe } from "./blackboard/resolveSafe.js";
import { promises as fs } from "node:fs";
import type { ExitContract } from "./blackboard/types.js";
import { skipCoversCriterionFiles } from "./councilSkipReconcile.js";
import { resolveCouncilToolProfile } from "./toolProfiles.js";
import { JSON_ARRAY_ONLY_LINE } from "./blackboard/prompts/sharedSnippets.js";

export { extractProviderText, createTimeoutController, parseJsonArrayFromResponse, gatherProjectContext, type RealManager } from "./councilUtils.js";

/** Extract todos from council synthesis — shared shape for drift/tests. */
export function buildCouncilTodoExtractPrompt(args: {
  progressBlock: string;
  synthesisText: string;
  recentDrafts: string;
  treeSection: string;
  componentStructure: string;
  serviceStructure: string;
  projectFiles: string;
  committedFilesSection: string;
}): string {
  return [
    "You are extracting ACTIONABLE work items from a council discussion. The council agreed on specific changes. Extract each concrete change as a separate todo.",
    args.progressBlock.trim() ? args.progressBlock.trim() : "",
    "",
    "Council synthesis:",
    args.synthesisText.slice(0, 3000),
    "",
    "Recent discussion context:",
    args.recentDrafts.slice(0, 1500),
    args.treeSection,
    args.componentStructure,
    args.serviceStructure,
    "",
    "EXISTING FILES IN PROJECT (DO NOT create duplicates):",
    args.projectFiles,
    "",
    "ALREADY COMMITTED (files changed this run):",
    args.committedFilesSection,
    "",
    "CRITICAL: Use your read/grep tools to inspect the actual content of key files before generating todos. Read the current implementation of each panel and service. If a feature described in the synthesis already exists in the file, do NOT create a todo for it. If a panel exists but uses mock data, create a todo to wire real API data.",
    "",
    `${JSON_ARRAY_ONLY_LINE}`,
    '[{"description": "specific actionable change description", "expectedFiles": ["path/to/file.ts"]}]',
    "",
    "Rules:",
    "- Each item must be a CONCRETE, SPECIFIC file change the council agreed on.",
    "- USE YOUR TOOLS to read existing files and verify what's actually implemented vs what's still needed.",
    "- If a file already exists, READ IT to see if the work is already done. If it is, SKIP that todo.",
    "- Use the project structure above to suggest realistic file paths. If unsure, use an empty array for expectedFiles.",
    "- Max 8 items.",
    "- PARTITIONING (critical): at most ONE todo per file path — never emit two todos with the same expectedFiles entry.",
    "- Order items: (1) implementation/source files, (2) test files, (3) docs/markdown, (4) run/test commands (pytest, npm test) as the LAST item(s).",
    "- AVOID creating duplicate files. If two panels serve similar purposes, merge them into one.",
    "- If the synthesis mentions specific panels/features, each gets its own todo unless they share the same file.",
    "- IMPORTANT: If creating a new component, also create a todo to integrate it into the app (e.g., add import and route in App.tsx).",
    "- If modifying an existing panel, also create a todo to update any related imports or routes.",
    '- Include a "type" field: "normal" for standard work, "contradiction" for cleanup/consolidation/merge tasks.',
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

/** Planner fallback when auditor stuck — unmet criteria → todos. */
export function buildAuditorUnmetTodoFallbackPrompt(
  unmetCriteria: ReadonlyArray<{ description: string; expectedFiles: string[] }>,
  opts?: { directive?: string; committedFiles?: readonly string[] },
): string {
  const directive = (opts?.directive ?? "").trim();
  const recent = (opts?.committedFiles ?? []).slice(0, 12);
  return [
    `You are the planner. The auditor found ${unmetCriteria.length} unmet criteria:`,
    "",
    ...unmetCriteria.map(
      (c) => `- ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`,
    ),
    "",
    directive
      ? `USER DIRECTIVE (authoritative):\n${directive.slice(0, 800)}\n`
      : "",
    recent.length > 0
      ? `Recently committed files (prefer editing these when relevant):\n${recent.map((f) => `- ${f}`).join("\n")}\n`
      : "",
    "Your task: For EACH unmet criterion, produce 1-2 concrete, actionable todos that would satisfy it.",
    "Each todo must have a specific description and list the files it would modify.",
    "Prefer progressive next steps (expand, implement, fix) — do not re-post work already permanent-skipped.",
    "If a criterion lists expectedFiles, at least one todo MUST target those paths.",
    "",
    JSON_ARRAY_ONLY_LINE,
    '[{"description": "specific change", "expectedFiles": ["path/to/file.ts"]}]',
    "",
    "Max 8 todos. Every file path MUST appear in the PROJECT FILES list (or the criterion's expectedFiles).",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

/** Follow-up todos from incomplete audit findings (JSON-array contract). */
export function buildAuditFollowUpTodoPrompt(args: {
  missingWork: string;
  treeSection: string;
}): string {
  return [
    "The council audit found incomplete work. Extract specific actionable todos to complete it.",
    "",
    "Incomplete work identified by auditors:",
    args.missingWork.slice(0, 2000),
    args.treeSection.trim() ? args.treeSection : "",
    "",
    JSON_ARRAY_ONLY_LINE,
    '[{"description": "specific actionable change", "expectedFiles": ["path/to/file.ts"]}]',
    "",
    "Rules:",
    "- Each item must be a CONCRETE, SPECIFIC change to complete the incomplete work.",
    "- Max 4 items.",
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

type CouncilRepos = {
  listTopLevel: (path: string) => Promise<string[]>;
  listRepoFiles: (path: string, opts: { maxFiles: number }) => Promise<string[]>;
};

/** Runtime repair todos must not be dropped when target files already exist. */
function isRuntimeFixTodo(description: string): boolean {
  const d = description.toLowerCase();
  return (
    /\b(fix|crash|import|attributeerror|nameerror|typeerror|filenotfounderror|module-level)\b/.test(d)
    && /\.(py|ts|tsx|js|jsx|mjs|cjs)\b/.test(d)
  );
}

function filesGuardedByUnmetCriteria(
  files: readonly string[],
  contract: ExitContract | null | undefined,
): boolean {
  if (!contract) return false;
  const unmet = contract.criteria.filter((c) => c.status === "unmet");
  if (unmet.length === 0) return false;
  for (const c of unmet) {
    if (skipCoversCriterionFiles(files, c.expectedFiles)) return true;
  }
  return false;
}

export async function extractTodosFromAudit(
  lead: Agent,
  cfg: RunConfig,
  missingWork: string,
  repos: CouncilRepos,
  manager: RealManager,
): Promise<Array<{ id: string; description: string; expectedFiles: string[] }>> {
  let treeSection = "";
  try {
    const tree = (await repos.listTopLevel(cfg.localPath)).slice(0, 50);
    treeSection = `\nProject top-level files: ${tree.join(", ")}`;
  } catch { /* ignore */ }

  const prompt = buildAuditFollowUpTodoPrompt({
    missingWork,
    treeSection,
  });

  try {
    const { controller, cleanup } = createTimeoutController();
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager: manager as any,
        agentName: resolveCouncilToolProfile(cfg),
        signal: controller.signal,
        webToolsConfig: cfg,
        activity: { kind: "council", label: "audit follow-up todos" },
      });
      const text = extractProviderText(raw);
      if (text === null) return [];
      return parseJsonArrayFromResponse(text, (t: Record<string, unknown>, i: number) => ({
        id: `audit-t${i + 1}-${Date.now()}`,
        description: String(t.description ?? `Task ${i + 1}`),
        expectedFiles: Array.isArray(t.expectedFiles) ? t.expectedFiles.map(String) : [],
      }));
    } finally {
      cleanup();
    }
  } catch {
    return [];
  }
}

export async function extractActionableTodos(
  lead: Agent,
  cfg: RunConfig,
  transcript: TranscriptEntry[],
  repos: CouncilRepos,
  appendSystem: (msg: string) => void,
  manager: { list: () => Agent[]; recordStreamingText?: (id: string, text: string) => void },
  contract?: ExitContract | null,
  progressContext?: string,
): Promise<Array<{ id: string; description: string; expectedFiles: string[] }>> {
  const synthesisEntry = [...transcript]
    .reverse()
    .find((e) => e.summary?.kind === "council_synthesis");
  if (!synthesisEntry) return [];

  const ctx = await gatherProjectContext(cfg.localPath, repos);

  const recentDrafts = transcript
    .filter((e) => e.role === "agent" && e.summary?.kind === "council_draft")
    .slice(-3)
    .map((e) => `[Agent ${e.agentIndex}] ${e.text.slice(0, 500)}`)
    .join("\n");

  const progressBlock = progressContext?.trim() ? `\n${progressContext}\n` : "";

  const prompt = buildCouncilTodoExtractPrompt({
    progressBlock,
    synthesisText: synthesisEntry.text,
    recentDrafts,
    treeSection: ctx.treeSection,
    componentStructure: ctx.componentStructure,
    serviceStructure: ctx.serviceStructure,
    projectFiles: ctx.projectFiles,
    committedFilesSection: ctx.committedFilesSection,
  });

  try {
    const { controller, cleanup } = createTimeoutController(COUNCIL_TODO_EXTRACT_TIMEOUT_MS);
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager: manager as any,
        agentName: resolveCouncilToolProfile(cfg),
        signal: controller.signal,
        webToolsConfig: cfg,
        activity: { kind: "council", label: "extract actionable todos" },
      });
      const text = extractProviderText(raw);
      if (text === null) {
        appendSystem(`[extractActionableTodos] empty response from provider.`);
        return [];
      }
      const result = parseJsonArrayFromResponse(text, (t: Record<string, unknown>, i: number) => ({
        id: `council-t${i + 1}-${Date.now()}`,
        description: String(t.description ?? `Task ${i + 1}`),
        expectedFiles: Array.isArray(t.expectedFiles) ? t.expectedFiles.map(String) : [],
        type: String(t.type ?? "normal"),
      }));
      if (result.length === 0) {
        appendSystem(`[extractActionableTodos] no JSON array found in response.`);
        return [];
      }

      let repoFiles: string[] = [];
      try {
        repoFiles = await repos.listRepoFiles(cfg.localPath, { maxFiles: 500 });
      } catch { /* ignore */ }

      const verified: typeof result = [];
      for (const t of result) {
        const desc = t.description.toLowerCase();
        const isCreate = desc.includes("create") || desc.includes("new") || desc.includes("add");

        const { accepted, rejected } = classifyExpectedFiles(t.expectedFiles, repoFiles);
        if (rejected.length > 0) {
          appendSystem(
            `[path grounding] Warned on ${rejected.length} suspicious path(s) in "${t.description}": ${rejected.map((r) => r.path).join(", ")}`,
          );
        }

        const filesWithRealContent: string[] = [];
        for (const f of accepted) {
          try {
            const abs = await resolveSafe(cfg.localPath, f);
            const raw = await fs.readFile(abs, "utf8");
            const content = raw.split("\n").slice(0, 20).join("\n").trim();
            if (!content || content.length < 20) continue;
            const lower = content.toLowerCase();
            if (lower.includes("todo") || lower.includes("placeholder") || lower.includes("mock") || lower.includes("fixme")) {
              continue;
            }
            filesWithRealContent.push(f);
          } catch {
            // skip unreadable or escaping paths
          }
        }

        const guarded = filesGuardedByUnmetCriteria(accepted, contract);

        if (
          isCreate &&
          accepted.length > 0 &&
          filesWithRealContent.length === accepted.length &&
          !guarded
        ) {
          if (isRuntimeFixTodo(t.description)) {
            appendSystem(
              `[dedup] Keeping runtime fix "${t.description.slice(0, 120)}…" — not skipping despite existing file content.`,
            );
            verified.push({ ...t, expectedFiles: accepted });
            continue;
          }
          appendSystem(`[dedup] Skipping "${t.description}" — files already exist with real content.`);
          continue;
        }

        if (isCreate && accepted.length > 0 && filesWithRealContent.length < accepted.length) {
          const existingFiles = accepted.filter((f) => repoFiles.includes(f));
          if (existingFiles.length > 0) {
            appendSystem(`[dedup] Converting "${t.description}" from create to modify — files exist with placeholder content.`);
          }
        }

        if (guarded && filesWithRealContent.length === accepted.length) {
          appendSystem(
            `[dedup] Keeping "${t.description}" — linked to unmet contract criteria despite existing content.`,
          );
        }

        if (accepted.length > 0) {
          verified.push({ ...t, expectedFiles: accepted });
        }
      }

      appendSystem(`[extractActionableTodos] extracted ${verified.length} todo(s).`);
      return verified;
    } finally {
      cleanup();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      /operation was aborted|aborted/i.test(msg);
    if (aborted) {
      appendSystem(
        `[extractActionableTodos] extraction timed out/aborted after budget — continuing without synthesis todos (audit can still enqueue).`,
      );
    } else {
      appendSystem(`[extractActionableTodos] extraction failed: ${msg}`);
    }
    return [];
  }
}