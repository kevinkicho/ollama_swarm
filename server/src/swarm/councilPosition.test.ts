// 2026-05-02 (council improvement #2 + #4): tests for the position
// extractor + composer. Pure-function tests; runner wiring is covered
// structurally in CouncilRunner.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPositionBlock,
  getLastPositionForAgent,
  collectAgentPositions,
  buildCouncilPositionsSection,
} from "./councilPosition.js";
import type { TranscriptEntry } from "../types.js";

function agentTurn(agentIndex: number, text: string, ts = agentIndex): TranscriptEntry {
  return { id: `e${agentIndex}-${ts}`, role: "agent", agentIndex, text, ts };
}

describe("extractPositionBlock", () => {
  it("returns null when heading is absent", () => {
    assert.equal(extractPositionBlock("Just commentary, no heading."), null);
  });

  it("extracts body after `### MY POSITION`", () => {
    const text = "Some intro prose.\n\n### MY POSITION\nKEEP: ship the bcrypt refactor first";
    assert.equal(extractPositionBlock(text), "KEEP: ship the bcrypt refactor first");
  });

  it("is case-insensitive on the literal MY POSITION", () => {
    assert.equal(
      extractPositionBlock("### my position\nfoo bar"),
      "foo bar",
    );
  });

  it("tolerates a trailing colon in the heading", () => {
    assert.equal(
      extractPositionBlock("### MY POSITION:\nbody"),
      "body",
    );
  });

  it("stops body at the next H1/H2/H3 heading", () => {
    const text = [
      "### MY POSITION",
      "KEEP: do the thing",
      "WHY: nobody convinced me otherwise",
      "",
      "### Other Notes",
      "should NOT appear",
    ].join("\n");
    assert.equal(
      extractPositionBlock(text),
      "KEEP: do the thing\nWHY: nobody convinced me otherwise",
    );
  });

  it("returns empty string when heading exists but body is whitespace", () => {
    assert.equal(extractPositionBlock("### MY POSITION\n\n\n"), "");
  });
});

describe("getLastPositionForAgent", () => {
  it("returns null when the agent has never produced one", () => {
    const t: TranscriptEntry[] = [agentTurn(1, "no position block here")];
    assert.equal(getLastPositionForAgent(t, 1), null);
  });

  it("returns the most-recent position when the agent has multiple turns", () => {
    const t: TranscriptEntry[] = [
      agentTurn(1, "draft 1\n### MY POSITION\nposition v1", 1),
      agentTurn(2, "other agent unrelated"),
      agentTurn(1, "draft 2\n### MY POSITION\nposition v2 LATEST", 5),
    ];
    assert.equal(getLastPositionForAgent(t, 1), "position v2 LATEST");
  });

  it("does not pick another agent's position", () => {
    const t: TranscriptEntry[] = [
      agentTurn(2, "### MY POSITION\nagent 2's pos"),
    ];
    assert.equal(getLastPositionForAgent(t, 1), null);
  });

  it("ignores non-agent transcript entries", () => {
    const t: TranscriptEntry[] = [
      { id: "s1", role: "system", text: "### MY POSITION\nsystem msg", ts: 1 },
      { id: "u1", role: "user", text: "### MY POSITION\nuser msg", ts: 2 },
      agentTurn(1, "### MY POSITION\nfrom agent"),
    ];
    assert.equal(getLastPositionForAgent(t, 1), "from agent");
  });
});

describe("collectAgentPositions", () => {
  it("emits one entry per agent in agent-index order", () => {
    const t: TranscriptEntry[] = [
      agentTurn(1, "### MY POSITION\np1"),
      agentTurn(2, "no block"),
      agentTurn(3, "### MY POSITION\np3"),
    ];
    const out = collectAgentPositions(t, 3);
    assert.equal(out.length, 3);
    assert.equal(out[0].agentIndex, 1);
    assert.equal(out[0].produced, true);
    assert.equal(out[0].body, "p1");
    assert.equal(out[1].agentIndex, 2);
    assert.equal(out[1].produced, false);
    assert.equal(out[2].body, "p3");
  });

  it("handles agentCount > number of agents in transcript", () => {
    const out = collectAgentPositions([], 5);
    assert.equal(out.length, 5);
    for (const p of out) assert.equal(p.produced, false);
  });
});

describe("buildCouncilPositionsSection", () => {
  it("renders one `### Agent N` sub-heading per agent", () => {
    const t: TranscriptEntry[] = [
      agentTurn(1, "### MY POSITION\nfirst pos"),
      agentTurn(2, "### MY POSITION\nsecond pos"),
    ];
    const section = buildCouncilPositionsSection(t, 2);
    assert.equal(section.title, "Per-agent positions (latest)");
    assert.match(section.body, /### Agent 1\s*\n\nfirst pos/);
    assert.match(section.body, /### Agent 2\s*\n\nsecond pos/);
  });

  it("renders a placeholder for agents that never produced a position", () => {
    const t: TranscriptEntry[] = [agentTurn(1, "### MY POSITION\nonly agent 1")];
    const section = buildCouncilPositionsSection(t, 3);
    assert.match(section.body, /### Agent 1\s*\n\nonly agent 1/);
    assert.match(section.body, /### Agent 2[\s\S]*did not produce a `### MY POSITION` block/);
    assert.match(section.body, /### Agent 3[\s\S]*did not produce a `### MY POSITION` block/);
  });
});
