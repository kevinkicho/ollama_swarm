// 2026-05-02 (role-diff improvement #4): tests for the per-role
// deliverable extractor + composer. Pure-function tests; the runner
// wiring is covered structurally in RoundRobinRunner.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDeliverableBlock,
  collectRoleDeliverables,
  findRoleDiffSynthesis,
  buildRoleDiffDeliverableSections,
} from "./roleDiffDeliverable.js";
import type { TranscriptEntry } from "../types.js";
import type { SwarmRole } from "./roles.js";

const ROLES: readonly SwarmRole[] = [
  { name: "Researcher", guidance: "" },
  { name: "Designer", guidance: "" },
  { name: "Implementer", guidance: "" },
];

function agentTurn(agentIndex: number, text: string, ts = agentIndex): TranscriptEntry {
  return { id: `e${agentIndex}-${ts}`, role: "agent", agentIndex, text, ts };
}

describe("extractDeliverableBlock", () => {
  it("returns null when heading is absent", () => {
    assert.equal(extractDeliverableBlock("Just commentary, no heading."), null);
  });

  it("extracts body after `### MY DELIVERABLE`", () => {
    const text = "Some intro prose.\n\n### MY DELIVERABLE\n- bullet 1\n- bullet 2\n";
    assert.equal(extractDeliverableBlock(text), "- bullet 1\n- bullet 2");
  });

  it("is case-insensitive on the literal MY DELIVERABLE", () => {
    const text = "### my deliverable\nfoo bar";
    assert.equal(extractDeliverableBlock(text), "foo bar");
  });

  it("tolerates a trailing colon in the heading", () => {
    const text = "### MY DELIVERABLE:\nbody here";
    assert.equal(extractDeliverableBlock(text), "body here");
  });

  it("stops body at the next H1/H2/H3 heading", () => {
    const text = [
      "### MY DELIVERABLE",
      "- item 1",
      "- item 2",
      "",
      "### Other Notes",
      "should NOT appear",
    ].join("\n");
    assert.equal(extractDeliverableBlock(text), "- item 1\n- item 2");
  });

  it("returns empty string when heading exists but body is whitespace", () => {
    const text = "### MY DELIVERABLE\n\n\n";
    assert.equal(extractDeliverableBlock(text), "");
  });
});

describe("collectRoleDeliverables", () => {
  it("returns one entry per agent in agent-index order", () => {
    const transcript: TranscriptEntry[] = [
      agentTurn(1, "thoughts.\n### MY DELIVERABLE\nresearcher r1"),
      agentTurn(2, "no deliverable here"),
      agentTurn(3, "thoughts.\n### MY DELIVERABLE\nimpl r1"),
    ];
    const out = collectRoleDeliverables(transcript, ROLES, 3);
    assert.equal(out.length, 3);
    assert.equal(out[0].roleName, "Researcher");
    assert.equal(out[0].agentIndex, 1);
    assert.equal(out[0].produced, true);
    assert.equal(out[0].body, "researcher r1");
    assert.equal(out[1].roleName, "Designer");
    assert.equal(out[1].produced, false);
    assert.equal(out[2].roleName, "Implementer");
    assert.equal(out[2].produced, true);
    assert.equal(out[2].body, "impl r1");
  });

  it("picks the LAST deliverable per agent across multiple turns", () => {
    const transcript: TranscriptEntry[] = [
      agentTurn(1, "### MY DELIVERABLE\nfirst draft", 1),
      agentTurn(1, "### MY DELIVERABLE\nFINAL revision", 5),
    ];
    const out = collectRoleDeliverables(transcript, ROLES, 1);
    assert.equal(out[0].body, "FINAL revision");
  });

  it("modulo-wraps role catalog when agentCount > roles.length", () => {
    const out = collectRoleDeliverables([], ROLES, 5);
    assert.equal(out.length, 5);
    assert.equal(out[0].roleName, "Researcher");
    assert.equal(out[3].roleName, "Researcher"); // wraps
    assert.equal(out[4].roleName, "Designer");
  });

  it("ignores non-agent transcript entries", () => {
    const transcript: TranscriptEntry[] = [
      { id: "s1", role: "system", text: "### MY DELIVERABLE\nsystem msg", ts: 1 },
      { id: "u1", role: "user", text: "### MY DELIVERABLE\nuser msg", ts: 2 },
      agentTurn(1, "### MY DELIVERABLE\nfrom agent"),
    ];
    const out = collectRoleDeliverables(transcript, ROLES, 1);
    assert.equal(out[0].body, "from agent");
  });
});

describe("findRoleDiffSynthesis", () => {
  it("returns null when no synthesis bubble exists", () => {
    const transcript: TranscriptEntry[] = [agentTurn(1, "just a turn")];
    assert.equal(findRoleDiffSynthesis(transcript), null);
  });

  it("finds an entry tagged with summary.kind === role_diff_synthesis", () => {
    const transcript: TranscriptEntry[] = [
      agentTurn(1, "regular turn"),
      {
        id: "syn",
        role: "agent",
        agentIndex: 1,
        text: "the synthesis text",
        ts: 99,
        summary: { kind: "role_diff_synthesis", rounds: 3, roles: 7 },
      },
    ];
    assert.equal(findRoleDiffSynthesis(transcript), "the synthesis text");
  });

  it("picks the LAST synthesis when multiple exist (midpoint + final)", () => {
    const transcript: TranscriptEntry[] = [
      {
        id: "mid",
        role: "agent",
        agentIndex: 1,
        text: "midpoint synthesis",
        ts: 50,
        summary: { kind: "role_diff_synthesis", rounds: 4, roles: 7 },
      },
      {
        id: "fin",
        role: "agent",
        agentIndex: 1,
        text: "final synthesis",
        ts: 100,
        summary: { kind: "role_diff_synthesis", rounds: 4, roles: 7 },
      },
    ];
    assert.equal(findRoleDiffSynthesis(transcript), "final synthesis");
  });
});

describe("buildRoleDiffDeliverableSections", () => {
  it("includes the directive section first, even when directive is absent", () => {
    const sections = buildRoleDiffDeliverableSections({
      roles: ROLES,
      agentCount: 3,
      transcript: [],
    });
    assert.equal(sections[0].title, "Directive");
    assert.match(sections[0].body, /no directive/i);
  });

  it("renders the directive verbatim when present", () => {
    const sections = buildRoleDiffDeliverableSections({
      userDirective: "Refactor auth to use bcrypt instead of MD5.",
      roles: ROLES,
      agentCount: 3,
      transcript: [],
    });
    assert.equal(sections[0].body, "Refactor auth to use bcrypt instead of MD5.");
  });

  it("emits one section per agent (in agent order) with role names", () => {
    const sections = buildRoleDiffDeliverableSections({
      roles: ROLES,
      agentCount: 3,
      transcript: [],
    });
    // [0] = Directive, [1..3] = per-role
    assert.equal(sections[1].title, "Researcher (Agent 1)");
    assert.equal(sections[2].title, "Designer (Agent 2)");
    assert.equal(sections[3].title, "Implementer (Agent 3)");
  });

  it("appends a Synthesis section when present in the transcript", () => {
    const sections = buildRoleDiffDeliverableSections({
      userDirective: "go",
      roles: ROLES,
      agentCount: 1,
      transcript: [
        {
          id: "syn",
          role: "agent",
          agentIndex: 1,
          text: "the consolidated answer",
          ts: 1,
          summary: { kind: "role_diff_synthesis", rounds: 2, roles: 1 },
        },
      ],
    });
    const synth = sections.find((s) => s.title === "Synthesis");
    assert.ok(synth, "Synthesis section must exist when synthesis bubble present");
    assert.equal(synth!.body, "the consolidated answer");
  });

  it("OMITS the Synthesis section when no synthesis was produced", () => {
    const sections = buildRoleDiffDeliverableSections({
      roles: ROLES,
      agentCount: 1,
      transcript: [agentTurn(1, "just a regular turn, no synthesis bubble")],
    });
    assert.ok(!sections.some((s) => s.title === "Synthesis"));
  });

  it("renders a placeholder body for roles that produced no deliverable", () => {
    const sections = buildRoleDiffDeliverableSections({
      roles: ROLES,
      agentCount: 2,
      transcript: [agentTurn(1, "no MY DELIVERABLE block here")],
    });
    assert.match(sections[1].body, /did not produce a `### MY DELIVERABLE` block/);
    assert.match(sections[2].body, /did not produce a `### MY DELIVERABLE` block/);
  });
});
