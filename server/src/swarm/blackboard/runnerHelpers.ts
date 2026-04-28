// Pure helpers used by BlackboardRunner. Extracted to keep the runner
// file's tail navigable — these have no this-binding and no coupling
// to BlackboardRunner internals, so they're a clean split.
//
// - bumpAgentCounter: increment a per-agent counter Map.
// - countNewlines: line count for hunk attribution (trailing-newline tolerant).
// - checkExpectedSymbols: verify planner-declared symbols actually exist in
//   the todo's expectedFiles (Task #70 grounding).

import { promises as fs } from "node:fs";
import path from "node:path";

// Task #67: small helper to bump a per-agent counter Map without
// repeating the `(map.get(id) ?? 0) + 1` pattern at every call site.
// Mutates in place; no return value.
export function bumpAgentCounter(m: Map<string, number>, agentId: string): void {
  m.set(agentId, (m.get(agentId) ?? 0) + 1);
}

// Task #66: count line-equivalents in a hunk's text. Empty string → 0.
// Trailing-newline-tolerant: "a\nb" and "a\nb\n" both count as 2 lines.
// Used for per-agent linesAdded / linesRemoved attribution.
export function countNewlines(s: string): number {
  if (!s) return 0;
  // Strip a single trailing \n so "a\n" doesn't count as 2 lines.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

// Task #70: word-boundary symbol grounding. For each declared
// expectedSymbol, read each expectedFile and grep for the symbol as
// a whole word (\bsym\b). The symbol is "found" if it appears in
// AT LEAST ONE of the todo's expectedFiles — the planner often
// declares two files where one contains the symbol and the other
// will receive the new edit. Files that don't exist on disk count
// as "not found" but are NOT a strike against the symbol (could be
// a create-style todo). Returns ok=true if every symbol is found
// in some file, or ok=false with the missing list otherwise.
export async function checkExpectedSymbols(
  todo: { description: string; expectedFiles: string[]; expectedSymbols?: string[] },
  clonePath: string,
): Promise<{ ok: true } | { ok: false; missing: Array<{ symbol: string; file: string }> }> {
  const symbols = todo.expectedSymbols;
  if (!symbols || symbols.length === 0) return { ok: true };
  // Pre-read all expectedFiles once — avoid re-reading per symbol.
  const fileContents = new Map<string, string>();
  let anyFileExists = false;
  for (const file of todo.expectedFiles) {
    try {
      const text = await fs.readFile(path.join(clonePath, file), "utf8");
      fileContents.set(file, text);
      anyFileExists = true;
    } catch {
      // Doesn't exist — skip. Probably a create-style todo for this file.
    }
  }
  // If NO expectedFile exists, this is a pure create todo — symbol
  // grounding can't apply. Allow.
  if (!anyFileExists) return { ok: true };
  const missing: Array<{ symbol: string; file: string }> = [];
  for (const sym of symbols) {
    // Escape regex metachars; word-boundary on both sides for whole-
    // word match. \b is a Unicode-poor approximation but matches the
    // common JS/TS identifier shape (letters + digits + _).
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    let foundIn: string | null = null;
    for (const [file, text] of fileContents.entries()) {
      if (re.test(text)) {
        foundIn = file;
        break;
      }
    }
    if (!foundIn) {
      // Report against the FIRST existing file for the finding text
      // (the planner declared multiple — if missing from all of them,
      // pointing at one is enough context).
      const firstExisting = todo.expectedFiles.find((f) => fileContents.has(f)) ?? todo.expectedFiles[0];
      missing.push({ symbol: sym, file: firstExisting });
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}
