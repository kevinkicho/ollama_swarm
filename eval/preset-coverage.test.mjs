/**
 * Quality gate: every swarm preset appears in at least one catalog task
 * (or is explicitly listed as eval-exempt). Fails CI if a new preset is
 * added without eval coverage intent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(here, "catalog.json"), "utf8"));

/** All presets the product ships (must stay in sync with shared PresetId). */
const ALL_PRESETS = [
  "blackboard",
  "council",
  "round-robin",
  "role-diff",
  "map-reduce",
  "debate-judge",
  "orchestrator-worker",
  "orchestrator-worker-deep",
  "stigmergy",
  "moa",
  "baseline",
  "pipeline",
];

/** Presets allowed to lack catalog tasks (must be documented). */
const EVAL_EXEMPT = {
  pipeline: "Composite of other presets; covered via sub-preset tasks",
};

describe("eval catalog preset coverage", () => {
  it("every non-exempt preset appears in ≥1 catalog task", () => {
    const covered = new Set();
    for (const task of catalog.tasks ?? []) {
      for (const p of task.presets ?? []) covered.add(p);
    }
    const missing = [];
    for (const p of ALL_PRESETS) {
      if (EVAL_EXEMPT[p]) continue;
      if (!covered.has(p)) missing.push(p);
    }
    assert.deepEqual(
      missing,
      [],
      `Presets missing from eval/catalog.json: ${missing.join(", ")}. ` +
        `Add a task or document in EVAL_EXEMPT.`,
    );
  });

  it("catalog tasks only reference known presets", () => {
    const known = new Set([...ALL_PRESETS]);
    const unknown = [];
    for (const task of catalog.tasks ?? []) {
      for (const p of task.presets ?? []) {
        if (!known.has(p)) unknown.push(`${task.id}:${p}`);
      }
    }
    assert.deepEqual(unknown, [], `Unknown presets in catalog: ${unknown.join(", ")}`);
  });

  it("analysis tasks have qualityRubric when expectFilesChanged is false", () => {
    const weak = [];
    for (const task of catalog.tasks ?? []) {
      if (task.expectFilesChanged === false && !task.qualityRubric) {
        weak.push(task.id);
      }
    }
    assert.deepEqual(
      weak,
      [],
      `Analysis tasks without qualityRubric (chatty free points risk): ${weak.join(", ")}`,
    );
  });
});
