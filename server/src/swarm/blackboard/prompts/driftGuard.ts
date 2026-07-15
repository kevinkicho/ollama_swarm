// Pre-start drift check. Validates that all prompt registry assertions
// pass against the prompt source text. Runs before Orchestrator.start()
// to catch model behavior changes before production runs stall.
//
// Usage: Called automatically from Orchestrator.start().
//   npx tsx server/scripts/drift-check.ts  (standalone)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  /** Entries where expanded SYSTEM_PROMPT import failed (content needles rely on source text only). */
  expandFailures: Array<{ prompt: string; sourceFile: string; reason: string }>;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candResolved = path.resolve(candidate);
  const rel = path.relative(rootResolved, candResolved);
  // Outside root → relative path starts with .. or is absolute
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a registry sourceFile to an absolute path.
 * - `prompts/...` → under blackboard/
 * - otherwise → under swarm/ (discussion helpers, bestOfN, etc.)
 * Rejects path escape (`..` segments that leave the root).
 */
export function resolveRegistrySourcePath(sourceFile: string): string {
  const normalized = sourceFile.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`invalid registry sourceFile: ${sourceFile}`);
  }
  const underBlackboard = normalized.startsWith("prompts/");
  const root = underBlackboard ? blackboardRoot : swarmRoot;
  const resolved = path.resolve(root, normalized);
  if (!isPathInsideRoot(root, resolved)) {
    throw new Error(
      `registry sourceFile escapes root: ${sourceFile} → ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Best-effort strip of // line comments and /* block comments *\/.
 * Limitations (documented on purpose — not a full TS parser):
 * - Only treats `"` for "inside string" when deciding line-comment starts
 *   (template literals / `'` / escaped quotes can mis-strip).
 * - Block removal is non-greedy `/* ... *\/` and can break on nested or
 *   string-embedded comment markers.
 * Good enough for our prompt modules; do not rely on perfect fidelity.
 */
function stripTsComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) ?? []).length;
      if (quotes % 2 === 1) return line;
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
  const m = assertion.match(/MUST (?:mention|contain|require)\s+(.+)$/i);
  if (!m) return [];
  return m[1]!
    .split(/[\s,;:()]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 3)
    .filter(
      (t) =>
        !/^(prompt|output|field|array|object|rule|only|valid|json|format|as|the|and|with|from|when)$/i.test(
          t,
        ),
    );
}

/**
 * Concatenate long string exports from a module so drift checks can see
 * expanded SYSTEM_PROMPT text (including spread shared snippets), not only
 * import identifiers in source.
 * Tries the path as-is first (tsx can load `.ts`), then sibling `.js`.
 */
async function loadExpandedExportText(
  absTsPath: string,
): Promise<{ text: string; error?: string }> {
  const candidates = [
    absTsPath,
    absTsPath.replace(/\.ts$/, ".js"),
  ];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      const parts: string[] = [];
      for (const v of Object.values(mod as Record<string, unknown>)) {
        if (typeof v === "string" && v.length >= 40) {
          parts.push(v);
        } else if (
          Array.isArray(v) &&
          v.length > 0 &&
          v.every((x) => typeof x === "string")
        ) {
          const joined = (v as string[]).join("\n");
          if (joined.length >= 40) parts.push(joined);
        }
      }
      return { text: parts.join("\n") };
    } catch (err) {
      errors.push(
        `${path.basename(candidate)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { text: "", error: errors.join(" | ") };
}

export async function checkPromptDrift(): Promise<DriftCheckResult> {
  const registry = await import("./registry.js");
  const entries = registry.promptRegistry;

  let totalAssertions = 0;
  let failedAssertions = 0;
  const failures: Array<{ prompt: string; assertion: string }> = [];
  const expandFailures: Array<{ prompt: string; sourceFile: string; reason: string }> = [];

  for (const entry of entries) {
    let promptPath = "";
    try {
      promptPath = resolveRegistrySourcePath(entry.sourceFile);
    } catch (err) {
      failedAssertions++;
      totalAssertions++;
      failures.push({
        prompt: entry.name,
        assertion: `source path invalid: ${entry.sourceFile} (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }

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

    const expandedResult = await loadExpandedExportText(promptPath);
    if (expandedResult.error) {
      expandFailures.push({
        prompt: entry.name,
        sourceFile: entry.sourceFile,
        reason: expandedResult.error,
      });
    }
    const expanded = expandedResult.text;
    // Prefer expanded runtime strings for "MUST mention" content checks;
    // keep full source for identifiers / structure.
    const mentionCorpus = (promptText + "\n" + expanded).toLowerCase();
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
          if (token === "```json" || token === "```") {
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
          // Check expanded+source corpus so emitted prompt text counts
          // even when it only appears via shared snippet spread.
          ok = needles.every((n) => mentionCorpus.includes(n.toLowerCase()));
        }
      } else if (assertion.includes("MUST prohibit")) {
        const match = assertion.match(/MUST prohibit.*?['']?([A-Za-z-]+)/i);
        if (match && !mentionCorpus.includes(match[1]!.toLowerCase())) {
          ok = false;
        }
      } else if (assertion.includes("MUST limit")) {
        const m =
          assertion.match(/MAX_HUNKS\s*\(?\s*(\d+)/i) ||
          assertion.match(/\((\d+)\)/);
        if (m && !promptText.includes(m[1]!) && !expanded.includes(m[1]!)) {
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
    expandFailures,
  };
}
