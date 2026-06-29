// councilDecisions.ts — Todo extraction for Council preset
// Kept: extractActionableTodos, extractTodosFromAudit
// Removed: Gate 1 (verifyTodo), Gate 3 (resolveContradiction), Gate 4 (recoverDeletedFiles)

import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TranscriptEntry } from "../types.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText, createTimeoutController, parseJsonArrayFromResponse, gatherProjectContext, type RealManager } from "./councilUtils.js";
import { classifyExpectedFiles } from "./blackboard/prompts/pathValidation.js";
import { execSync } from "node:child_process";

export { extractProviderText, createTimeoutController, parseJsonArrayFromResponse, gatherProjectContext, type RealManager } from "./councilUtils.js";

export async function extractTodosFromAudit(
  lead: Agent,
  cfg: RunConfig,
  missingWork: string,
  repos: { listTopLevel: (path: string) => Promise<string[]> },
  manager: RealManager,
): Promise<Array<{ id: string; description: string; expectedFiles: string[] }>> {
  let treeSection = "";
  try {
    const tree = (await repos.listTopLevel(cfg.localPath)).slice(0, 50);
    treeSection = `\nProject top-level files: ${tree.join(", ")}`;
  } catch { /* ignore */ }

  const prompt = `The council audit found incomplete work. Extract specific actionable todos to complete it.

Incomplete work identified by auditors:
${missingWork.slice(0, 2000)}
${treeSection}

Return ONLY a JSON array:
[{"description": "specific actionable change", "expectedFiles": ["path/to/file.ts"]}]

Rules:
- Each item must be a CONCRETE, SPECIFIC change to complete the incomplete work.
- Max 4 items.`;

  try {
    const { controller, cleanup } = createTimeoutController();
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager,
        agentName: "swarm-read",
        signal: controller.signal,
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
  repos: { listTopLevel: (path: string) => Promise<string[]> },
  appendSystem: (msg: string) => void,
  manager: { list: () => Agent[]; recordStreamingText?: (id: string, text: string) => void },
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

  const prompt = `You are extracting ACTIONABLE work items from a council discussion. The council agreed on specific changes. Extract each concrete change as a separate todo.

Council synthesis:
${synthesisEntry.text.slice(0, 3000)}

Recent discussion context:
${recentDrafts.slice(0, 1500)}
${ctx.treeSection}
${ctx.componentStructure}
${ctx.serviceStructure}

EXISTING FILES IN PROJECT (DO NOT create duplicates):
${ctx.projectFiles}

ALREADY COMMITTED (files changed this run):
${ctx.committedFilesSection}

CRITICAL: Use your read/grep tools to inspect the actual content of key files before generating todos. Read the current implementation of each panel and service. If a feature described in the synthesis already exists in the file, do NOT create a todo for it. If a panel exists but uses mock data, create a todo to wire real API data.

Return ONLY a JSON array. No markdown, no code fences, no explanation:
[{"description": "specific actionable change description", "expectedFiles": ["path/to/file.ts"]}]

Rules:
- Each item must be a CONCRETE, SPECIFIC file change the council agreed on.
- USE YOUR TOOLS to read existing files and verify what's actually implemented vs what's still needed.
- If a file already exists, READ IT to see if the work is already done. If it is, SKIP that todo.
- Use the project structure above to suggest realistic file paths. If unsure, use an empty array for expectedFiles.
- Max 8 items.
- AVOID creating duplicate files. If two panels serve similar purposes, merge them into one.
- If the synthesis mentions specific panels/features, each gets its own todo.
- IMPORTANT: If creating a new component, also create a todo to integrate it into the app (e.g., add import and route in App.tsx).
- If modifying an existing panel, also create a todo to update any related imports or routes.
- Include a "type" field: "normal" for standard work, "contradiction" for cleanup/consolidation/merge tasks.`;

  try {
    const { controller, cleanup } = createTimeoutController();
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager,
        agentName: "swarm-read",
        signal: controller.signal,
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

      // Post-process: verify file paths exist and check for placeholder content
      let fileList = "";
      try {
        fileList = execSync(
          'find . -type f \\( -name "*.tsx" -o -name "*.ts" -o -name "*.js" -o -name "*.jsx" \\) | grep -v node_modules | grep -v .git',
          { cwd: cfg.localPath, encoding: "utf8", timeout: 10000 }
        ).trim();
      } catch { /* ignore */ }

      const repoFiles = fileList.split("\n").filter(Boolean);

      const verified = result.map((t) => {
        const desc = t.description.toLowerCase();
        const isCreate = desc.includes("create") || desc.includes("new") || desc.includes("add");

        const { accepted, rejected } = classifyExpectedFiles(t.expectedFiles, repoFiles);
        if (rejected.length > 0) {
          appendSystem(`[path grounding] Dropped ${rejected.length} invalid path(s) from "${t.description}": ${rejected.map(r => r.path).join(", ")}`);
        }

        const filesWithRealContent = accepted.filter((f) => {
          try {
            const content = execSync(`head -20 "${cfg.localPath}/${f}" 2>/dev/null || echo ""`, {
              timeout: 1000, encoding: "utf8",
            }).trim();
            if (!content || content.length < 20) return false;
            const lower = content.toLowerCase();
            if (lower.includes("todo") || lower.includes("placeholder") || lower.includes("mock") || lower.includes("fixme")) return false;
            return true;
          } catch {
            return false;
          }
        });

        if (isCreate && accepted.length > 0 && filesWithRealContent.length === accepted.length) {
          appendSystem(`[dedup] Skipping "${t.description}" — files already exist with real content.`);
          return null;
        }

        if (isCreate && accepted.length > 0 && filesWithRealContent.length < accepted.length) {
          const existingFiles = accepted.filter((f) => repoFiles.includes(f));
          if (existingFiles.length > 0) {
            appendSystem(`[dedup] Converting "${t.description}" from create to modify — files exist with placeholder content.`);
          }
        }

        return { ...t, expectedFiles: accepted };
      }).filter((t): t is NonNullable<typeof t> => t !== null && t.expectedFiles.length > 0);

      appendSystem(`[extractActionableTodos] extracted ${verified.length} todo(s).`);
      return verified;
    } finally {
      cleanup();
    }
  } catch (err) {
    appendSystem(`[extractActionableTodos] extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
