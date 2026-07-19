#!/usr/bin/env node
/**
 * Offline multi-tab HTML reliability smoke (no LLM).
 *
 * Validates the 1963ce25 thrash path end-to-end against pure helpers:
 *   1. Extract disk tab inventory from multi-tab HTML
 *   2. Detect false already-done skips when topics are missing
 *   3. Allow / auto-skip when topics are covered
 *   4. Disk-first synthetic workingTree from write tool traces
 *   5. Empty-reemit prompt includes inventory
 *   6. RR-A: create-on-existing + multi-match replace stay fail-closed
 *
 * Usage: node scripts/smoke-tab-inventory.mjs
 * Exit 0 on pass; non-zero on first assertion failure.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(root, "server");

const env = {
  ...process.env,
  OPENCODE_SERVER_PASSWORD:
    process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD.length > 0
      ? process.env.OPENCODE_SERVER_PASSWORD
      : "test-only",
};

/** Run focused server tests that lock multi-tab + RR-A paths. */
const FILES = [
  "src/swarm/blackboard/tabInventory.test.ts",
  "src/swarm/blackboard/diskFirstWorkerSettle.test.ts",
  "src/swarm/dualPathCascade.test.ts",
  "src/swarm/blackboard/applyHunks.test.ts",
  "src/swarm/applyOrGroundedRepair.test.ts",
  "src/swarm/blackboard/prompts/worker.test.ts",
  "src/swarm/blackboard/prompts/replanner.test.ts",
];

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function inlineScenario() {
  // Dynamic import via tsx-compiled path: run through a tiny tsx eval.
  // Prefer spawning tsx to load TS modules from server package.
  const script = `
import assert from "node:assert/strict";
import {
  extractTabsFromHtml,
  buildTabInventories,
  renderTabInventoryBlock,
  tabSkipContradictsInventory,
  extractRequestedTabTopics,
  selectPathsForTabInventory,
  seedLikelyNeedsTabInventory,
} from "./src/swarm/blackboard/tabInventory.ts";
import {
  pathsFromSuccessfulMutateTools,
  pickDiskFirstFiles,
  synthesizeWorkingTreeParse,
} from "./src/swarm/blackboard/diskFirstWorkerSettle.ts";
import { buildWorkerEmptyReemitPrompt } from "./src/swarm/blackboard/prompts/worker.ts";
import { applyFileHunks } from "./src/swarm/blackboard/applyHunks.ts";

const HTML = \`
<div class="tabs" role="tablist">
  <div class="tab" role="tab" onclick="switchTab(0)">Cantor's Infinities</div>
  <div class="tab" role="tab" onclick="switchTab(1)">Hilbert's Hotel</div>
  <div class="tab" role="tab" onclick="switchTab(2)">Ordinals</div>
</div>
\`;

// 1. Inventory
const tabs = extractTabsFromHtml(HTML);
assert.equal(tabs.length, 3, "extract 3 tabs");
const inv = buildTabInventories({ "18_infinity.html": HTML });
assert.equal(inv[0].tabs.length, 3);
const block = renderTabInventoryBlock(inv);
assert.match(block, /GROUND TRUTH/);
assert.match(block, /Hilbert/);

// 2. False already-done skip when topics missing
const badSkip = tabSkipContradictsInventory(
  "file already contains 12 tabs covering exterior derivative",
  'Add tabs for "Riemann curvature" and "frame dragging"',
  inv,
);
assert.equal(badSkip.contradicts, true, "missing topics contradict skip");

// 3. Covered topics → no contradiction (replan auto-skip signal)
const goodSkip = tabSkipContradictsInventory(
  "already contains tabs covering requested topics",
  "Ensure tabs for Ordinals and Hilbert's Hotel exist",
  inv,
);
assert.equal(goodSkip.contradicts, false, "covered topics ok");

// 4. Path selection + seed gate
assert.equal(seedLikelyNeedsTabInventory("Add 5 new tabs with canvas", ["a.html"]), true);
const paths = selectPathsForTabInventory(
  ["misc.md", "14_diff_geometry.html", "other.html"],
  "expand 14_diff_geometry tabs",
  4,
);
assert.ok(paths.some((p) => p.includes("diff_geometry")));

// 5. Disk-first from tool traces
const toolPaths = pathsFromSuccessfulMutateTools([
  { tool: "write", ok: true, preview: "18_infinity.html → wrote 9000 chars", ts: 1 },
]);
assert.deepEqual(toolPaths, ["18_infinity.html"]);
const picked = pickDiskFirstFiles(["18_infinity.html"], toolPaths, []);
assert.deepEqual(picked, ["18_infinity.html"]);
const syn = synthesizeWorkingTreeParse(picked, "add riemann tab");
assert.equal(syn.ok, true);
assert.equal(syn.workingTree, true);

// 6. Empty reemit includes inventory
const reemit = buildWorkerEmptyReemitPrompt(
  { description: "Add Riemann tab", expectedFiles: ["18_infinity.html"] },
  "empty response",
  { tabInventoryBlock: block },
);
assert.match(reemit, /workingTree/);
assert.match(reemit, /GROUND TRUTH/);

// 7. RR-A: create on existing fails
const createFail = applyFileHunks("existing body", [
  { op: "create", file: "x.html", content: "new" },
], "x.html");
assert.equal(createFail.ok, false);
assert.match(createFail.error || createFail.miss?.message || "", /already exists|create/i);

// 8. RR-A: multi-match replace fails closed
const multi = applyFileHunks("aa shared\\nbb shared\\n", [
  { op: "replace", file: "x.html", search: "shared", replace: "X" },
], "x.html");
assert.equal(multi.ok, false);
assert.equal(multi.miss?.kind, "search_not_unique");

console.log("INLINE_OK");
`;

  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: serverRoot, encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    console.error("inline scenario failed:");
    console.error(r.stdout?.slice(-2000));
    console.error(r.stderr?.slice(-2000));
    process.exit(1);
  }
  assert(r.stdout.includes("INLINE_OK"), "inline multi-tab scenario completed");
}

function runUnitBundle() {
  process.stdout.write("• unit bundle (tab + RR-A + cascade) ... ");
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...FILES],
    { cwd: serverRoot, encoding: "utf8", env },
  );
  if (r.status !== 0) {
    console.log("FAIL");
    console.log(r.stdout?.slice(-2500));
    console.log(r.stderr?.slice(-1500));
    process.exit(1);
  }
  const m = /ℹ pass (\d+)/.exec(r.stdout ?? "");
  console.log(m ? `ok (${m[1]} pass)` : "ok");
}

console.log("\n=== Multi-tab HTML reliability smoke (offline) ===\n");
await inlineScenario();
runUnitBundle();
console.log("\n✅ Multi-tab HTML smoke passed (no LLM required)\n");
console.log("Manual live still recommended for full swarm:");
console.log("  - Blackboard/council run with multi-tab HTML directive on a real clone");
console.log("  - Watch [tab-inventory] system lines + no replan thrash on covered topics\n");
