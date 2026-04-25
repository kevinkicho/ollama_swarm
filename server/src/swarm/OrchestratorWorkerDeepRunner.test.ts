import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_OW_MIN_AGENTS,
  TARGET_WORKERS_PER_MID_LEAD,
  buildMidLeadPlanPrompt,
  buildMidLeadSynthesisPrompt,
  buildTopPlanPrompt,
  buildTopSynthesisPrompt,
  computeDeepTopology,
} from "./OrchestratorWorkerDeepRunner.js";
import type { TranscriptEntry } from "../types.js";

describe("computeDeepTopology — sizing rules", () => {
  it("throws below the documented minimum agent count", () => {
    for (let n = 1; n < DEEP_OW_MIN_AGENTS; n++) {
      assert.throws(() => computeDeepTopology(n), /at least 4 agents/);
    }
  });

  it("at the floor (4 agents) → 1 orchestrator, 1 mid-lead, 2 workers", () => {
    const t = computeDeepTopology(4);
    assert.equal(t.orchestratorIndex, 1);
    assert.deepEqual(t.midLeadIndices, [2]);
    assert.deepEqual(t.workerIndices, [3, 4]);
    assert.deepEqual(t.workerByMidLead, [[3, 4]]);
  });

  it("targets ~6 workers per mid-lead by ceil((N-1)/6) (small case)", () => {
    // 7 agents = 1 orch + ceil(6/6)=1 mid-lead + 5 workers
    const t = computeDeepTopology(7);
    assert.equal(t.midLeadIndices.length, 1);
    assert.equal(t.workerIndices.length, 5);
  });

  it("scales mid-leads up with agent count", () => {
    // 8 agents = 1 orch + ceil(7/6)=2 mid-leads + 5 workers
    const t8 = computeDeepTopology(8);
    assert.equal(t8.midLeadIndices.length, 2);
    assert.equal(t8.workerIndices.length, 5);

    // 18 agents = 1 orch + ceil(17/6)=3 mid-leads + 14 workers
    const t18 = computeDeepTopology(18);
    assert.equal(t18.midLeadIndices.length, 3);
    assert.equal(t18.workerIndices.length, 14);

    // 30 agents = 1 orch + ceil(29/6)=5 mid-leads + 24 workers
    const t30 = computeDeepTopology(30);
    assert.equal(t30.midLeadIndices.length, 5);
    assert.equal(t30.workerIndices.length, 24);
  });

  it("never gives a mid-lead zero workers (caps K at floor((N-1)/3))", () => {
    // 5 agents = 1 orch + 4 remaining. ceil(4/6)=1 target K. floor(4/3)=1 cap.
    // Result: 1 mid-lead + 3 workers. (No degenerate empty pools.)
    const t = computeDeepTopology(5);
    assert.equal(t.midLeadIndices.length, 1);
    for (const pool of t.workerByMidLead) {
      assert.ok(pool.length >= 2, `mid-lead pool ${pool} should have ≥2 workers`);
    }
  });

  it("partitions workers round-robin so disparity ≤1", () => {
    // 18 agents → 3 mid-leads, 14 workers. Round-robin yields 5/5/4 or 5/4/5.
    const t = computeDeepTopology(18);
    const sizes = t.workerByMidLead.map((g) => g.length);
    const max = Math.max(...sizes);
    const min = Math.min(...sizes);
    assert.ok(max - min <= 1, `worker partition disparity ${max - min} > 1: sizes=${sizes}`);
    // Sum equals total workers.
    assert.equal(sizes.reduce((s, n) => s + n, 0), t.workerIndices.length);
  });

  it("indices are contiguous and start at 1 (orch) → 2..K+1 (mid-leads) → K+2..N (workers)", () => {
    const t = computeDeepTopology(12);
    const k = t.midLeadIndices.length;
    assert.equal(t.orchestratorIndex, 1);
    assert.deepEqual(t.midLeadIndices, Array.from({ length: k }, (_, i) => i + 2));
    assert.deepEqual(
      t.workerIndices,
      Array.from({ length: 12 - 1 - k }, (_, i) => i + 2 + k),
    );
  });

  it("uses the documented target ratio constant", () => {
    // Sanity-check the magic number stays surfaced in case someone tunes it.
    assert.equal(TARGET_WORKERS_PER_MID_LEAD, 6);
  });
});

const sys = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});
const agent = (idx: number, text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "agent",
  agentIndex: idx,
  agentId: `agent-${idx}`,
  text,
  ts: 0,
});

describe("buildTopPlanPrompt", () => {
  it("addresses the orchestrator and lists the available mid-leads", () => {
    const out = buildTopPlanPrompt(1, 5, [2, 3], []);
    assert.match(out, /ORCHESTRATOR/);
    assert.match(out, /MID-LEADS: Agent 2, Agent 3/);
    assert.match(out, /cycle 1\/5/);
  });

  it("forbids done:true on cycle 1", () => {
    const out = buildTopPlanPrompt(1, 5, [2], []);
    assert.match(out, /On cycle 1, `done` MUST be false/);
  });

  it("requires JSON output and explicitly forbids prose / fences", () => {
    const out = buildTopPlanPrompt(2, 5, [2, 3, 4], [sys("seed text")]);
    assert.match(out, /no prose, no fences/);
    assert.match(out, /"assignments"/);
  });

  it("renders prior transcript so subsequent cycles can refine", () => {
    const out = buildTopPlanPrompt(2, 5, [2], [sys("prior cycle synth")]);
    assert.match(out, /prior cycle synth/);
  });
});

describe("buildMidLeadPlanPrompt", () => {
  it("identifies the mid-lead by index and lists its workers", () => {
    const out = buildMidLeadPlanPrompt(3, 1, 5, "audit src/", [4, 5, 6], []);
    assert.match(out, /MID-LEAD Agent 3/);
    assert.match(out, /Agent 4, Agent 5, Agent 6/);
    assert.match(out, /audit src\//);
  });

  it("isolates workers — they do NOT see peer plans or orchestrator output", () => {
    const out = buildMidLeadPlanPrompt(2, 1, 5, "x", [4], []);
    assert.match(out, /Workers see only their fine subtask \+ the seed/);
    assert.match(out, /not your plan, not the orchestrator's plan, not peer worker reports/);
  });
});

describe("buildMidLeadSynthesisPrompt", () => {
  it("orients the synthesis upward toward the orchestrator", () => {
    const out = buildMidLeadSynthesisPrompt(2, 1, 5, "audit src/", [
      agent(4, "worker 4 report"),
    ]);
    assert.match(out, /upward to the orchestrator/i);
    assert.match(out, /worker 4 report/);
  });

  it("re-states the mid-lead's coarse subtask so the synthesis stays anchored", () => {
    const out = buildMidLeadSynthesisPrompt(2, 1, 5, "VERIFY README ACCURACY", []);
    assert.match(out, /VERIFY README ACCURACY/);
  });
});

describe("buildTopSynthesisPrompt", () => {
  it("instructs the orchestrator to draw on mid-lead reports, not raw observations", () => {
    const out = buildTopSynthesisPrompt(1, 5, [agent(2, "mid-lead 2 synth")]);
    assert.match(out, /mid-lead synthesis/i);
    assert.match(out, /workers already filtered the raw observations/i);
    assert.match(out, /mid-lead 2 synth/);
  });

  it("on the final cycle asks for a final recommendation, not a forward-looking gap", () => {
    const out = buildTopSynthesisPrompt(5, 5, []);
    assert.match(out, /final recommendation now that this is the last cycle/);
  });

  it("on a non-final cycle asks for a forward-looking gap callout", () => {
    const out = buildTopSynthesisPrompt(2, 5, []);
    assert.match(out, /a future cycle should investigate/);
  });
});
