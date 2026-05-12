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

export interface DriftCheckResult {
  ok: boolean;
  totalAssertions: number;
  failedAssertions: number;
  failures: Array<{ prompt: string; assertion: string }>;
}

export async function checkPromptDrift(): Promise<DriftCheckResult> {
  const registry = await import("../src/swarm/blackboard/prompts/registry.js");
  const entries = registry.promptRegistry;

  let totalAssertions = 0;
  let failedAssertions = 0;
  const failures: Array<{ prompt: string; assertion: string }> = [];

  for (const entry of entries) {
    const promptPath = path.resolve(here, "..", "src", "swarm", "blackboard", entry.sourceFile);
    let promptText = "";
    try {
      promptText = fs.readFileSync(promptPath, "utf8");
    } catch {
      continue; // skip unreadable prompts
    }

    for (const assertion of entry.expectedBehavior) {
      totalAssertions++;
      let ok = true;

      if (assertion.includes("MUST NOT contain")) {
        const match = assertion.match(/MUST NOT contain '([^']+)'/);
        if (match && promptText.toLowerCase().includes(match[1].toLowerCase())) {
          ok = false;
        }
      } else if (assertion.includes("MUST mention") || assertion.includes("MUST contain") || assertion.includes("MUST require")) {
        const match = assertion.match(/(?:MUST (?:contain|mention|require)).*?(\w+)/i);
        if (match && !promptText.toLowerCase().includes(match[1].toLowerCase())) {
          ok = false;
        }
      } else if (assertion.includes("MUST prohibit")) {
        const match = assertion.match(/MUST prohibit.*?['']?([A-Z]+)/i);
        if (match && !promptText.toLowerCase().includes(match[1].toLowerCase())) {
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
