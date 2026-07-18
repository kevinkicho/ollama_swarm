import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractControlAdviceFromTranscript,
  extractControlAdviceFromEventRecords,
  mergeControlAdvice,
  computeResilienceRollup,
} from "./controlAdvice.js";

describe("controlAdvice hydrate helpers", () => {
  it("extracts stall gate and tool coach from transcript", () => {
    const advice = extractControlAdviceFromTranscript([
      {
        role: "system",
        text: "[control] Stall gate (rule): backoff — quota wall detected",
        ts: 100,
      },
      {
        role: "system",
        text: "[control] Tool coach (bash, 3×): use forward slashes on Windows",
        ts: 200,
      },
    ]);
    assert.equal(advice.length, 2);
    assert.equal(advice[0]!.kind, "stall_gate");
    assert.equal(advice[0]!.action, "backoff");
    assert.equal(advice[1]!.kind, "tool_coach");
    assert.equal(advice[1]!.tool, "bash");
  });

  it("extracts brain-os lines as resilience events", () => {
    const advice = extractControlAdviceFromTranscript([
      {
        role: "system",
        text: "[brain-os] done status=resolved effects+1/-0: closed apply miss",
        ts: 300,
      },
      {
        role: "system",
        text: "[brain-os] dispatch kind=tool_block privilege=runner depth=0 todo=—",
        ts: 250,
      },
    ]);
    assert.ok(advice.some((a) => a.kind === "brain_os" && a.status === "resolved"));
    assert.ok(advice.some((a) => a.kind === "brain_os" && a.conflictKind === "tool_block"));
  });

  it("extracts swarm_control_advice from event log records", () => {
    const advice = extractControlAdviceFromEventRecords([
      {
        event: {
          type: "swarm_control_advice",
          ts: 50,
          kind: "tool_coach",
          agentId: "agent-2",
          tool: "read",
          rationale: "try relative paths",
        },
      },
    ]);
    assert.equal(advice.length, 1);
    assert.equal(advice[0]!.agentId, "agent-2");
  });

  it("mergeControlAdvice dedupes by kind+ts+rationale", () => {
    const merged = mergeControlAdvice(
      [{ ts: 1, kind: "stall_gate", rationale: "same", action: "stop" }],
      [{ ts: 1, kind: "stall_gate", rationale: "same", action: "stop" }],
      [{ ts: 2, kind: "tool_coach", rationale: "hint", tool: "bash" }],
    );
    assert.equal(merged.length, 2);
  });

  it("computeResilienceRollup scores recovery vs hard stops", () => {
    const healthy = computeResilienceRollup([
      { ts: 1, kind: "tool_coach", rationale: "use read" },
      { ts: 2, kind: "brain_os", rationale: "ok", status: "resolved" },
    ]);
    assert.ok(healthy.score >= 70);
    assert.equal(healthy.brainOsEvents, 1);
    const fragile = computeResilienceRollup([
      { ts: 1, kind: "stall_gate", action: "stop", rationale: "dead" },
      { ts: 2, kind: "stall_gate", action: "stop", rationale: "still dead" },
    ]);
    assert.ok(fragile.score < healthy.score);
    assert.equal(fragile.label === "fragile" || fragile.label === "stressed", true);
  });
});