import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  finalizeAgentOutput,
  formatFinalizeAnomalyLine,
  TRANSCRIPT_FINAL_TEXT_HARD_MAX,
} from "./finalizeAgentOutput.js";

const PHRASE =
  "I'll fetch the BIS API to understand the raw SDMX JSON structure, then craft a transformation that yields an array of objects with length > 0. response";

describe("finalizeAgentOutput", () => {
  it("strips think tags and keeps JSON body", () => {
    const r = finalizeAgentOutput('<think>plan</think>{"hunks":[]}');
    assert.match(r.finalText, /"hunks"/);
    assert.match(r.thoughts, /plan/);
    assert.equal(r.anomalies.length, 0);
  });

  it("collapses phrase loops and reports anomaly", () => {
    const r = finalizeAgentOutput(`<think>x</think>${PHRASE.repeat(80)}`);
    assert.ok(r.loopCollapsed || r.anomalies.some((a) => a.kind === "phrase_loop_collapsed"));
    assert.ok(r.finalText.length < PHRASE.length * 20);
    const line = formatFinalizeAnomalyLine("agent-3", r.anomalies, r.stats);
    assert.ok(line);
    assert.match(line!, /stream-integrity/);
  });

  it("hard-caps enormous final text even without loop signature", () => {
    // High-entropy bulk that won't collapse as a phrase loop
    const parts: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      parts.push(`unique-line-${i}-${(i * 7919) % 9973} with payload`);
    }
    const r = finalizeAgentOutput(parts.join("\n"));
    assert.ok(r.finalText.length <= TRANSCRIPT_FINAL_TEXT_HARD_MAX + 120);
    assert.ok(r.anomalies.some((a) => a.kind === "hard_truncated"));
  });

  it("worker role suppresses long non-JSON prose", () => {
    const prose = "I will inspect the route and then fix it. ".repeat(40);
    const r = finalizeAgentOutput(prose, { role: "worker" });
    assert.match(r.finalText, /no JSON hunk envelope/i);
    assert.ok(r.finalText.length < prose.length);
  });

  it("worker role keeps valid hunk JSON", () => {
    const body = JSON.stringify({
      hunks: [{ op: "create", file: "a.ts", content: "x" }],
    });
    const r = finalizeAgentOutput(body, { role: "worker" });
    assert.match(r.finalText, /"hunks"/);
    assert.doesNotMatch(r.finalText, /suppressed/i);
  });
});
