// Auto-anchor detection for large files.
//
// When a worker or replanner needs to edit a section of a large file (>8KB)
// that's in the omitted middle region, this module extracts likely section
// names from the todo description and injects them as anchors. This triggers
// windowFileWithAnchors to show the relevant region instead of just head+tail.

import { WORKER_FILE_WINDOW_THRESHOLD } from "./windowFile.js";

/**
 * Extract likely section names from a todo description.
 *
 * Looks for:
 * - Quoted strings (e.g., "Demographics" → "Demographics")
 * - Capitalized words >3 chars that aren't common stop words
 *
 * Returns unique keywords that might appear as section headers in the target file.
 */
export function extractSectionKeywords(description: string): string[] {
  // Extract quoted strings first (highest confidence)
  const quoted = [...description.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // Common stop words to exclude
  const stopWords = new Set([
    "TODO", "CREATE", "UPDATE", "ADD", "DELETE", "MOVE", "FIX", "FILE",
    "THE", "AND", "FOR", "WITH", "FROM", "INTO", "THAT", "THIS",
    "WHICH", "WHERE", "WHEN", "HOW", "WHAT", "WHY", "ALL", "NEW",
    "EXISTING", "COMPONENT", "PANEL", "TAB", "ROUTE", "SERVER",
    "FRONTEND", "BACKEND", "TEST", "DOCS", "README",
  ]);

  // Extract capitalized words >3 chars (likely section names)
  const capitalized = description
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        /^[A-Z]/.test(w) &&
        !stopWords.has(w.toUpperCase()) &&
        !/^\d+$/.test(w), // not just numbers
    );

  return [...new Set([...quoted, ...capitalized])];
}

/**
 * Auto-detect anchors from a todo description for a set of files.
 *
 * For each large file (above WORKER_FILE_WINDOW_THRESHOLD), searches for
 * keywords from the description. Returns found keywords as anchors.
 *
 * @returns Array of anchor strings found in the files
 */
export function autoDetectAnchors(
  description: string,
  fileContents: Record<string, string | null>,
  expectedFiles: string[],
): string[] {
  const keywords = extractSectionKeywords(description);
  if (keywords.length === 0) return [];

  const anchors: string[] = [];
  for (const f of expectedFiles) {
    const content = fileContents[f];
    if (!content || content.length <= WORKER_FILE_WINDOW_THRESHOLD) continue;

    for (const kw of keywords) {
      if (content.indexOf(kw) >= 0) {
        anchors.push(kw);
      }
    }
  }

  return anchors;
}
