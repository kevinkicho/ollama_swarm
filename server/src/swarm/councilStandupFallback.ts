import { extractJsonCandidate } from "@ollama-swarm/shared/parseAgentJson";
import type { TranscriptEntry } from "../types.js";
import type { CouncilTodoDraft } from "./councilTodoPlan.js";

export interface StandupIssue {
  issue: string;
  file?: string;
  severity?: string;
  suggestion?: string;
}

export function parseStandupIssues(text: string): StandupIssue[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidate = extractJsonCandidate(trimmed);
  const jsonSlice = candidate?.json ?? trimmed;
  try {
    const parsed = JSON.parse(jsonSlice) as unknown;
    if (!Array.isArray(parsed)) return null;
    const issues: StandupIssue[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const issue = typeof o.issue === "string" ? o.issue.trim() : "";
      if (!issue) continue;
      issues.push({
        issue,
        file: typeof o.file === "string" ? o.file : undefined,
        severity: typeof o.severity === "string" ? o.severity : undefined,
        suggestion: typeof o.suggestion === "string" ? o.suggestion : undefined,
      });
    }
    return issues.length > 0 ? issues : null;
  } catch {
    return null;
  }
}

export function standupIssuesToTodoDrafts(
  issues: readonly StandupIssue[],
  createdBy = "standup-fallback",
): CouncilTodoDraft[] {
  const out: CouncilTodoDraft[] = [];
  const seen = new Set<string>();
  for (const item of issues) {
    const desc = [item.suggestion, item.issue].filter(Boolean).join(": ") || item.issue;
    const files = item.file ? [item.file] : [];
    const key = `${desc.slice(0, 80)}|${files.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      description: desc.slice(0, 500),
      expectedFiles: files,
      createdBy,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/** Collect standup issue arrays from agent drafts in a transcript window. */
export function extractStandupIssuesFromEntries(
  entries: readonly TranscriptEntry[],
): StandupIssue[] {
  const merged: StandupIssue[] = [];
  for (const e of entries) {
    if (e.role !== "agent") continue;
    if (e.summary?.kind !== "council_draft") continue;
    if ((e.summary as { phase?: string }).phase !== "standup") continue;
    const issues = parseStandupIssues(e.text ?? "");
    if (issues) merged.push(...issues);
  }
  return merged;
}

export function standupFallbackTodosFromEntries(
  entries: readonly TranscriptEntry[],
): CouncilTodoDraft[] {
  return standupIssuesToTodoDrafts(extractStandupIssuesFromEntries(entries));
}