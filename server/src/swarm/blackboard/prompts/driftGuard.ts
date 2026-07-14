// Pre-start drift check. Validates that all prompt registry assertions
// pass against the prompt source text. Runs before Orchestrator.start()
// to catch model behavior changes before production runs stall.
//
// Usage: Called automatically from Orchestrator.start().
//   npx tsx server/scripts/drift-check.ts  (standalone)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/src/swarm/blackboard */
const blackboardRoot = path.resolve(here, "..");
/** server/src/swarm */
const swarmRoot = path.resolve(here, "../..");

export interface DriftCheckResult {
  ok: boolean;
  totalAssertions: number;
  failedAssertions: number;
  failures: Array<{ prompt: string; assertion: string }>;
}

/**
 * Resolve a registry sourceFile to an absolute path.
 * - `prompts/...` → under blackboard/
 * - otherwise → under swarm/ (discussion helpers, bestOfN, etc.)
 */
export function resolveRegistrySourcePath(sourceFile: string): string {
  const normalized = sourceFile.replace(/\\/g, "/");
  if (normalized.startsWith("prompts/")) {
    return path.resolve(blackboardRoot, normalized);
  }
  return path.resolve(swarmRoot, normalized);
}

/** Strip // line comments and /* block comments *\/ so drift checks
 *  run against string content the model would see (or export text),
 *  not parser implementation notes. */
function stripTsComments(src: string): string {
  // Block comments first
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments (not inside strings — good enough for our prompt modules)
  out = out
    .split(/\r?\n/)
    .map((line) => {
      // Keep string content that has // inside quotes; simple heuristic:
      // only strip // that is outside of quotes by counting quotes before //.
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) ?? []).length;
      if (quotes % 2 === 1) return line; // inside string
      return before;
    })
    .join("\n");
  return out;
}

/** Extract significant keywords from a free-form assertion. */
function assertionNeedles(assertion: string): string[] {
  const quoted = [...assertion.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (quoted.length > 0) {
    return quoted.filter((q) => q.length > 0);
  }
  // Fall back: tokens after MUST mention/contain/require
  const m = assertion.match(
    /MUST (?:mention|contain|require)\s+(.+)$/i,
  );
  if (!m) return [];
  return m[1]!
    .split(/[\s,;:()]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 3)
    .filter((t) => !/^(prompt|output|field|array|object|rule|only|valid|json|format|as|the|and|with|from|when)$/i.test(t));
}

export async function checkPromptDrift(): Promise<DriftCheckResult> {
  const registry = await import("./registry.js");
  const entries = registry.promptRegistry;

  let totalAssertions = 0;
  let failedAssertions = 0;
  const failures: Array<{ prompt: string; assertion: string }> = [];

  for (const entry of entries) {
    const promptPath = resolveRegistrySourcePath(entry.sourceFile);
    let promptText = "";
    try {
      promptText = fs.readFileSync(promptPath, "utf8");
    } catch {
      failedAssertions++;
      totalAssertions++;
      failures.push({
        prompt: entry.name,
        assertion: `source file unreadable: ${entry.sourceFile} (resolved ${promptPath})`,
      });
      continue;
    }

    const codeSansComments = stripTsComments(promptText);
    const lowerFull = promptText.toLowerCase();
    const lowerCode = codeSansComments.toLowerCase();

    for (const assertion of entry.expectedBehavior) {
      totalAssertions++;
      let ok = true;

      if (assertion.includes("MUST NOT contain")) {
        const match = assertion.match(/MUST NOT contain '([^']+)'/);
        if (match) {
          const token = match[1]!.toLowerCase();
          // Fence tokens: only fail when a non-comment string actively
          // teaches wrapping the final answer in fences (positive example).
          if (token === "```json" || token === "```") {
            // After stripping comments, if ```json remains inside a
            // string that is part of SYSTEM_PROMPT instruction TO emit
            // fences — fail. Allow "No markdown fences" / "no fences".
            if (lowerCode.includes(token)) {
              const lines = codeSansComments.split(/\r?\n/);
              ok = !lines.some((line) => {
                if (!line.toLowerCase().includes(token)) return false;
                const l = line.toLowerCase();
                if (
                  l.includes("no markdown") ||
                  l.includes("no fences") ||
                  l.includes("no prose") ||
                  l.includes("without") ||
                  l.includes("must not") ||
                  l.includes("do not") ||
                  l.includes("don't") ||
                  l.includes("strip") ||
                  l.includes("unwrap") ||
                  l.includes("forbid")
                ) {
                  return false;
                }
                // Positive instruction like: wrap in ```json
                return true;
              });
            }
          } else if (lowerFull.includes(token)) {
            ok = false;
          }
        }
      } else if (
        assertion.includes("MUST mention") ||
        assertion.includes("MUST contain") ||
        assertion.includes("MUST require")
      ) {
        const needles = assertionNeedles(assertion);
        if (needles.length === 0) {
          ok = false;
        } else {
          // All quoted needles must appear; for unquoted, require every
          // significant token appears in the source.
          ok = needles.every((n) => lowerFull.includes(n.toLowerCase()));
        }
      } else if (assertion.includes("MUST prohibit")) {
        const match = assertion.match(/MUST prohibit.*?['']?([A-Za-z-]+)/i);
        if (match && !lowerFull.includes(match[1]!.toLowerCase())) {
          ok = false;
        }
      } else if (assertion.includes("MUST limit")) {
        const m =
          assertion.match(/MAX_HUNKS\s*\(?\s*(\d+)/i) ||
          assertion.match(/\((\d+)\)/);
        if (m && !promptText.includes(m[1]!)) {
          ok = false;
        }
      }

      if (!ok) {
        failedAssertions++;
        failures.push({ prompt: entry.name, assertion });
      }
    }
  }

  return {
    ok: failedAssertions === 0,
    totalAssertions,
    failedAssertions,
    failures,
  };
}
