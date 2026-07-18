import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  startBrainOsMetrics,
  mergeBrainOsMetrics,
  snapshotBrainOsMetrics,
} from "./metricsRegistry.js";
import { emptyBrainOsMetrics } from "@ollama-swarm/shared/brainOs";
import { parseHelperResult, parseChildDispatches } from "./parseHelperResult.js";

describe("brainOs metricsRegistry", () => {
  it("merges and snapshots per runId", () => {
    startBrainOsMetrics("run-a");
    mergeBrainOsMetrics("run-a", {
      ...emptyBrainOsMetrics(),
      dispatches: 2,
      resolved: 1,
      helpersSpawned: 2,
      childDispatches: 1,
    });
    const snap = snapshotBrainOsMetrics("run-a");
    assert.ok(snap);
    assert.equal(snap!.dispatches, 2);
    assert.equal(snap!.childDispatches, 1);
    assert.equal(snap!.resolved, 1);
  });

  it("returns undefined when unused", () => {
    startBrainOsMetrics("run-empty");
    assert.equal(snapshotBrainOsMetrics("run-empty"), undefined);
  });
});

describe("parseHelperResult children", () => {
  it("parses children follow-ups", () => {
    const raw = JSON.stringify({
      status: "partial",
      summary: "need apply help",
      effects: [{ type: "append_system", text: "hi" }],
      children: [{ kind: "apply_miss", hints: ["retry anchors"], todoId: "t1" }],
    });
    const r = parseHelperResult(raw, 10);
    assert.equal(r.status, "partial");
    assert.equal(r.followUpDispatches, 1);
    assert.ok(r.children);
    assert.equal(r.children![0]!.kind, "apply_miss");
  });

  it("parseChildDispatches filters unknown kinds", () => {
    const kids = parseChildDispatches({
      children: [{ kind: "nope" }, { kind: "tool_block" }],
    });
    assert.equal(kids.length, 1);
    assert.equal(kids[0]!.kind, "tool_block");
  });
});
