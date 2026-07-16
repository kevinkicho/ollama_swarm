import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectPeerStancesFromTranscript,
  standingsFromPeerStances,
  preferNonRejectedWinner,
  formatPeerStandingBlock,
} from "./peerDeliberationAggregate.js";

test("collectPeerStancesFromTranscript — extracts deliberate envelopes", () => {
  const stances = collectPeerStancesFromTranscript([
    {
      role: "agent",
      agentIndex: 1,
      text: `
\`\`\`deliberate
subject: agent-2 draft
claim: wrong arity fix
stance: deny
why: no evidence in file
\`\`\`
`,
    },
    {
      role: "agent",
      agentIndex: 3,
      text: `
\`\`\`deliberate
subject: agent-2 is correct
claim: good
stance: approve
why: cites predict_tc
to: agent-2
\`\`\`
`,
    },
  ]);
  assert.equal(stances.length, 2);
  assert.equal(stances[0]!.targetAgentIndex, 2);
  assert.equal(stances[0]!.stance, "deny");
  assert.equal(stances[1]!.stance, "approve");
});

test("standingsFromPeerStances — peerRejected when denies dominate", () => {
  const standings = standingsFromPeerStances(
    [1, 2, 3],
    [
      {
        fromAgentIndex: 1,
        subject: "agent-2",
        claim: "x",
        stance: "deny",
        why: "weak",
        targetAgentIndex: 2,
      },
      {
        fromAgentIndex: 3,
        subject: "agent-2",
        claim: "x",
        stance: "deny",
        why: "also weak",
        targetAgentIndex: 2,
      },
      {
        fromAgentIndex: 2,
        subject: "agent-1",
        claim: "y",
        stance: "approve",
        why: "ok",
        targetAgentIndex: 1,
      },
    ],
  );
  const a2 = standings.find((s) => s.agentIndex === 2)!;
  assert.equal(a2.peerRejected, true);
  assert.equal(a2.denies, 2);
  const a1 = standings.find((s) => s.agentIndex === 1)!;
  assert.equal(a1.peerSupported, true);
});

test("preferNonRejectedWinner — overrides peer-rejected winner", () => {
  const standings = standingsFromPeerStances(
    [1, 2],
    [
      {
        fromAgentIndex: 1,
        subject: "agent-2",
        claim: "x",
        stance: "deny",
        why: "no",
        targetAgentIndex: 2,
      },
      {
        fromAgentIndex: 2,
        subject: "agent-1",
        claim: "y",
        stance: "approve",
        why: "yes",
        targetAgentIndex: 1,
      },
    ],
  );
  const r = preferNonRejectedWinner(2, standings, [1, 2]);
  assert.equal(r.overridden, true);
  assert.equal(r.winnerIndex, 1);
});

test("formatPeerStandingBlock — empty when no stances", () => {
  assert.equal(formatPeerStandingBlock([{
    agentIndex: 1,
    approves: 0,
    denies: 0,
    challenges: 0,
    validates: 0,
    peerRejected: false,
    peerSupported: false,
    notes: [],
  }]), "");
});
