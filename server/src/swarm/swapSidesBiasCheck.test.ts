// Q7 (2026-05-04): tests for swap-sides bias check helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swapPositionLabels,
  compareVerdicts,
  shouldRunNextActionAfterBiasCheck,
} from "./swapSidesBiasCheck.js";
import type { TranscriptEntry } from "../types.js";
import type { ParsedDebateVerdict } from "./debatePromptHelpers.js";

function entry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    id: "x",
    role: "agent",
    text: "y",
    ts: 0,
    ...overrides,
  };
}

function verdict(overrides: Partial<ParsedDebateVerdict>): ParsedDebateVerdict {
  return {
    winner: "pro",
    confidence: "high",
    proStrongest: "p",
    conStrongest: "c",
    proWeakest: "",
    conWeakest: "",
    decisive: "",
    nextAction: "",
    ...overrides,
  };
}

test("swapPositionLabels — agent index 1↔2 swapped, 3 untouched", () => {
  const got = swapPositionLabels([
    entry({ agentIndex: 1 }),
    entry({ agentIndex: 2 }),
    entry({ agentIndex: 3 }),
  ]);
  assert.equal(got[0].agentIndex, 2);
  assert.equal(got[1].agentIndex, 1);
  assert.equal(got[2].agentIndex, 3);
});

test("swapPositionLabels — non-agent entries pass through", () => {
  const got = swapPositionLabels([
    entry({ role: "system", text: "x" }),
    entry({ role: "user", text: "y" }),
  ]);
  assert.equal(got[0].role, "system");
  assert.equal(got[1].role, "user");
});

test("swapPositionLabels — debate_turn summary kind also flipped", () => {
  const got = swapPositionLabels([
    entry({
      agentIndex: 1,
      summary: { kind: "debate_turn", role: "pro", round: 1 },
    }),
  ]);
  assert.equal(got[0].agentIndex, 2);
  assert.equal((got[0].summary as { role: string }).role, "con");
});

test("swapPositionLabels — does not mutate input array", () => {
  const input = [entry({ agentIndex: 1 })];
  const before = JSON.stringify(input);
  swapPositionLabels(input);
  assert.equal(JSON.stringify(input), before);
});

test("compareVerdicts — both tie → consistent", () => {
  const got = compareVerdicts({
    original: verdict({ winner: "tie" }),
    swapped: verdict({ winner: "tie" }),
  });
  assert.equal(got.discrepancy, "consistent");
});

test("compareVerdicts — same winner label across swap → bias-driven (winner-flipped)", () => {
  // Same SIDE LABEL won both times → judge picked by label not substance
  const got = compareVerdicts({
    original: verdict({ winner: "pro", confidence: "high" }),
    swapped: verdict({ winner: "pro", confidence: "high" }),
  });
  assert.equal(got.discrepancy, "winner-flipped");
  assert.ok(got.winnerFlipped);
  assert.match(got.note, /favor the PRO label/);
});

test("compareVerdicts — different winner across swap, confidence held → consistent (substance-driven)", () => {
  // Original PRO won; after swap, CON won. The substance arguer (now
  // labeled CON) is the same one. Confidence held → judgment is sound.
  const got = compareVerdicts({
    original: verdict({ winner: "pro", confidence: "high" }),
    swapped: verdict({ winner: "con", confidence: "high" }),
  });
  assert.equal(got.discrepancy, "consistent");
  assert.equal(got.winnerFlipped, false);
});

test("compareVerdicts — different winner, confidence dropped → degraded", () => {
  const got = compareVerdicts({
    original: verdict({ winner: "pro", confidence: "high" }),
    swapped: verdict({ winner: "con", confidence: "low" }),
  });
  assert.equal(got.discrepancy, "confidence-degraded");
  assert.ok(got.confidenceDegraded);
});

test("compareVerdicts — tie ↔ non-tie → degraded", () => {
  const got = compareVerdicts({
    original: verdict({ winner: "pro" }),
    swapped: verdict({ winner: "tie" }),
  });
  assert.equal(got.discrepancy, "confidence-degraded");
});

test("shouldRunNextActionAfterBiasCheck — consistent → true", () => {
  assert.equal(
    shouldRunNextActionAfterBiasCheck({
      discrepancy: "consistent",
      winnerFlipped: false,
      confidenceDegraded: false,
      note: "",
    }),
    true,
  );
});

test("shouldRunNextActionAfterBiasCheck — winner-flipped → false", () => {
  assert.equal(
    shouldRunNextActionAfterBiasCheck({
      discrepancy: "winner-flipped",
      winnerFlipped: true,
      confidenceDegraded: false,
      note: "",
    }),
    false,
  );
});

test("shouldRunNextActionAfterBiasCheck — confidence-degraded → false", () => {
  assert.equal(
    shouldRunNextActionAfterBiasCheck({
      discrepancy: "confidence-degraded",
      winnerFlipped: false,
      confidenceDegraded: true,
      note: "",
    }),
    false,
  );
});
