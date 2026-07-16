import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  distillDeliberationSeed,
  buildDeliberationSeed,
  todoMatchesDenyPattern,
  filterTodosAgainstDeliberationDenies,
} from "./deliberationSeed.js";
import type { DeliberationTransaction } from "./deliberationTypes.js";

function tx(
  partial: Partial<DeliberationTransaction> & Pick<DeliberationTransaction, "verdict" | "subject">,
): DeliberationTransaction {
  return {
    id: "x",
    ts: Date.now(),
    runId: "r",
    layer: "peer",
    claim: "c",
    proposer: "a",
    schemaVersion: 1,
    ...partial,
  };
}

test("distillDeliberationSeed — empty", () => {
  const g = distillDeliberationSeed([], 0);
  assert.equal(g.text, "");
});

test("distillDeliberationSeed — ranks deny/approve patterns", () => {
  const rows = [
    tx({ verdict: "deny", subject: "s", validationReason: "hunk search not found", layer: "hierarchy" }),
    tx({ verdict: "deny", subject: "s2", validationReason: "hunk search not found", layer: "hierarchy" }),
    tx({ verdict: "deny", subject: "s3", validationReason: "hunk search not found", layer: "hierarchy" }),
    tx({ verdict: "approve", subject: "s4", validationReason: "tests pass on auth", layer: "peer" }),
    tx({ verdict: "challenge", subject: "s5", claim: "bash wc fails on windows", layer: "control" }),
  ];
  const g = distillDeliberationSeed(rows, 2);
  assert.match(g.text, /Prior deliberation/);
  assert.match(g.text, /hunk search not found/);
  assert.match(g.text, /3×/);
  assert.match(g.text, /tests pass on auth/);
  assert.ok(g.denyCount >= 3);
  assert.ok(g.approveCount >= 1);
});

test("todoMatchesDenyPattern — matches token overlap", () => {
  assert.equal(
    todoMatchesDenyPattern(
      "Fix hunk search not found in predict_tc again",
      [{ sample: "hunk search not found in file", count: 3, layer: "hierarchy" }],
    ),
    true,
  );
  assert.equal(
    todoMatchesDenyPattern(
      "Add unit tests for auth middleware",
      [{ sample: "hunk search not found in file", count: 3, layer: "hierarchy" }],
    ),
    false,
  );
});

test("filterTodosAgainstDeliberationDenies — drops matches", () => {
  const { kept, dropped } = filterTodosAgainstDeliberationDenies(
    [
      { description: "hunk search not found recovery" },
      { description: "write new README section" },
    ],
    [{ sample: "hunk search not found recovery needed", count: 2, layer: "hierarchy" }],
  );
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 1);
});

test("buildDeliberationSeed — reads logs tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "delib-seed-"));
  const runDir = path.join(root, "logs", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  await fs.mkdir(runDir, { recursive: true });
  const row = tx({
    verdict: "deny",
    subject: "commit:x",
    validationReason: "zero files written",
    layer: "hierarchy",
  });
  await fs.writeFile(
    path.join(runDir, "deliberation.jsonl"),
    JSON.stringify(row) + "\n",
    "utf8",
  );
  const g = await buildDeliberationSeed(root);
  assert.match(g.text, /zero files written/);
  assert.equal(g.runsScanned, 1);
});
