// councilUtils.ts — Shared utilities for Council preset

import type { Agent } from "../services/AgentManager.js";
import { execSync } from "node:child_process";

/** Extract text from a provider response that may be a string or a
 *  structured object like {data:{parts:[{type:"text",text:"..."}]}}. */
export function extractProviderText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const parts = (obj.data as { parts?: Array<{ type: string; text: string }> })?.parts;
    if (parts && parts.length > 0 && typeof parts[0].text === "string" && parts[0].text.length > 0) {
      return parts[0].text;
    }
    if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
  }
  return null;
}

/** Real AgentManager — passed through from CouncilRunner.opts.manager */
export type RealManager = { list: () => Agent[]; [key: string]: unknown };

/**
 * Create an AbortController with a timeout.
 * Returns both the controller and a cleanup function to prevent timer leaks.
 */
export function createTimeoutController(ms = 90_000): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    cleanup: () => clearTimeout(timeoutId),
  };
}

/**
 * Parse a JSON array from AI response text.
 * Handles preamble text, code fences, and malformed JSON.
 */
export function parseJsonArrayFromResponse<T>(
  text: string,
  normalize: (item: any, i: number) => T
): T[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const cleaned = (start !== -1 && end > start)
    ? text.slice(start, end + 1)
    : text.replace(/```(?:json)?\s*/gi, "").trim();
  if (!cleaned.startsWith("[")) return [];
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalize);
}

/**
 * Gather project context for AI prompts.
 * Consolidates file tree, component structure, and service structure.
 */
export async function gatherProjectContext(
  localPath: string,
  repos?: { listTopLevel: (path: string) => Promise<string[]> },
): Promise<{
  projectFiles: string;
  componentStructure: string;
  serviceStructure: string;
  treeSection: string;
  committedFilesSection: string;
}> {
  let projectFiles = "";
  try {
    projectFiles = execSync(
      'find . -type f \\( -name "*.tsx" -o -name "*.ts" -o -name "*.js" -o -name "*.jsx" \\) | grep -v node_modules | grep -v .git | head -80',
      { cwd: localPath, encoding: "utf8", timeout: 10000 }
    ).trim();
  } catch { /* ignore */ }

  let componentStructure = "";
  try {
    componentStructure = execSync(
      'find ./src/components -type f -name "*.tsx" -o -name "*.jsx" 2>/dev/null | head -30',
      { cwd: localPath, encoding: "utf8", timeout: 5000 }
    ).trim();
    if (componentStructure) componentStructure = `\nExisting components:\n${componentStructure}`;
  } catch { /* ignore */ }

  let serviceStructure = "";
  try {
    serviceStructure = execSync(
      'find ./src/services -type f -name "*.ts" -o -name "*.js" 2>/dev/null | head -20',
      { cwd: localPath, encoding: "utf8", timeout: 5000 }
    ).trim();
    if (serviceStructure) serviceStructure = `\nExisting services:\n${serviceStructure}`;
  } catch { /* ignore */ }

  let treeSection = "";
  if (repos) {
    try {
      const tree = (await repos.listTopLevel(localPath)).slice(0, 50);
      treeSection = `\nProject top-level files: ${tree.join(", ")}`;
    } catch { /* ignore */ }
  }

  let committedFilesSection = "";
  try {
    const log = execSync(
      'git log --oneline --diff-filter=ACMR --name-only --since="1 hour ago" 2>/dev/null | grep -v "^[a-f0-9]" | grep -v "^$" | sort -u | head -30',
      { cwd: localPath, encoding: "utf8", timeout: 5000 }
    ).trim();
    if (log) committedFilesSection = `\nFiles changed in recent commits:\n${log}`;
  } catch { /* ignore */ }

  return { projectFiles, componentStructure, serviceStructure, treeSection, committedFilesSection };
}

/**
 * Check if a file is an ephemeral run artifact (should not be recovered).
 */
export function isEphemeralArtifact(filePath: string): boolean {
  return (
    filePath.startsWith("deliverable-") ||
    filePath.startsWith("next-actions-") ||
    filePath.startsWith("logs/") ||
    filePath.endsWith(".log") ||
    filePath.startsWith("summary-") ||
    filePath === "summary.json"
  );
}
