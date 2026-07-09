import { extractJsonFromText } from "@ollama-swarm/shared/extractJson";
import { summarizeAgentJson } from "@ollama-swarm/shared/summarizeAgentJson";

export interface CouncilSynthesisTodo {
  description: string;
  expectedFiles: string[];
}

export interface ParsedCouncilSynthesis {
  todos: CouncilSynthesisTodo[];
  prose: string;
  prettyJson: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function proseOutsideJson(raw: string, jsonSlice: string): string {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(jsonSlice);
  if (idx < 0) return "";
  const before = trimmed.slice(0, idx).trim();
  const after = trimmed.slice(idx + jsonSlice.length).trim();
  return [before, after].filter(Boolean).join("\n\n").trim();
}

/** Parse council synthesis agent text into todos + optional prose + pretty JSON. */
export function parseCouncilSynthesisText(text: string): ParsedCouncilSynthesis | null {
  const summary = summarizeAgentJson(text);
  if (summary?.parsed.kind === "todos" && summary.parsed.todos.length > 0) {
    const jsonSlice = extractJsonFromText(text) ?? summary.json;
    return {
      todos: summary.parsed.todos,
      prose: proseOutsideJson(text, jsonSlice),
      prettyJson: summary.json,
    };
  }

  const jsonSlice = extractJsonFromText(text);
  if (!jsonSlice) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const todos: CouncilSynthesisTodo[] = [];
  for (const item of parsed) {
    if (!isObject(item)) continue;
    const desc =
      typeof item.description === "string" ? item.description.trim() : "";
    if (!desc) continue;
    const expectedFiles = Array.isArray(item.expectedFiles)
      ? item.expectedFiles.filter((f): f is string => typeof f === "string")
      : [];
    todos.push({ description: desc, expectedFiles });
  }

  if (todos.length === 0) return null;

  let prettyJson: string;
  try {
    prettyJson = JSON.stringify(parsed, null, 2);
  } catch {
    prettyJson = jsonSlice;
  }

  return {
    todos,
    prose: proseOutsideJson(text, jsonSlice),
    prettyJson,
  };
}