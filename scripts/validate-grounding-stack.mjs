#!/usr/bin/env node
/**
 * Offline acceptance gates for the eee6718f grounding stack.
 * Runs focused unit tests via the workspace test runners (no live council).
 *
 * Usage: node scripts/validate-grounding-stack.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = {
  ...process.env,
  OPENCODE_SERVER_PASSWORD:
    process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD.length > 0
      ? process.env.OPENCODE_SERVER_PASSWORD
      : "test-only",
};

/** Server tests (cwd = server/) */
const serverFiles = [
  "src/swarm/blackboard/applyMissReport.test.ts",
  "src/swarm/blackboard/applyHunks.test.ts",
  "src/swarm/blackboard/prompts/worker.test.ts",
  "src/swarm/blackboard/workerSelfConsistency.test.ts",
  "src/swarm/research/localCatalogIndex.test.ts",
  "src/tools/searchAdapters.test.ts",
  "src/swarm/applyIntegrityStats.test.ts",
  "src/swarm/wrapUpApplyPhase.test.ts",
  "src/swarm/councilWorkerRunner.test.ts",
];

/** Shared package tests (cwd = shared/) */
const sharedFiles = ["src/applyIntegrityReport.test.ts"];

function runSuite(label, cwd, files) {
  process.stdout.write(`• ${label} (${files.length} files) ... `);
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { cwd, encoding: "utf8", env },
  );
  if (r.status === 0) {
    // Count pass line from node:test summary if present
    const m = /ℹ pass (\d+)/.exec(r.stdout ?? "");
    console.log(m ? `ok (${m[1]} pass)` : "ok");
    return true;
  }
  console.log("FAIL");
  if (r.stdout) console.log(r.stdout.slice(-3000));
  if (r.stderr) console.log(r.stderr.slice(-2000));
  return false;
}

console.log("\n=== Grounding stack offline validation ===\n");

const okServer = runSuite("server grounding tests", path.join(root, "server"), serverFiles);
const okShared = runSuite("shared applyIntegrityReport", path.join(root, "shared"), sharedFiles);

console.log("\nManual (live) still recommended:");
console.log("  - Panel-heavy council run on current main");
console.log("  - Compare applyIntegrity.missByKind vs eee6718f baseline");
console.log("  - Confirm literature noise near zero; catalog/keys for true research\n");

if (!okServer || !okShared) {
  console.error("❌ Grounding validation failed");
  process.exit(1);
}
console.log("✅ Offline grounding validation passed\n");
process.exit(0);
