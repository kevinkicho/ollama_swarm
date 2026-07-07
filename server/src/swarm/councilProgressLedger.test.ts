import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendLedgerObservation,
  buildProgressContextBlock,
  createEmptyLedger,
  harvestStandupFindingsFromEntries,
  ingestExecutionTranscriptLines,
  wrapProgressContextForPrompt,
} from "./councilProgressLedger.js";

describe("councilProgressLedger", () => {
  it("buildProgressContextBlock includes commits and skips neutrally", () => {
    const ledger = createEmptyLedger("run-abc-1234");
    ledger.lastCycle = 3;
    appendLedgerObservation(ledger, {
      kind: "commit",
      text: "agent-2 ✓ applied — abc1234.",
      cycle: 2,
    });
    appendLedgerObservation(ledger, {
      kind: "skip",
      text: "agent-3 skipped: already complete",
      cycle: 3,
      agentId: "agent-3",
    });
    const block = buildProgressContextBlock(ledger);
    assert.match(block, /Recent commits/);
    assert.match(block, /skipped/);
    assert.match(block, /cycle 3/);
    assert.doesNotMatch(block, /DO NOT/i);
  });

  it("harvestStandupFindingsFromEntries records agent findings", () => {
    const ledger = createEmptyLedger("run-x");
    const n = harvestStandupFindingsFromEntries(ledger, 5, [
      {
        id: "1",
        role: "agent",
        agentId: "agent-2",
        agentIndex: 2,
        text: '[{"issue":"stub script","file":"scripts/a.py","suggestion":"implement"}]',
        ts: 1,
        summary: { kind: "council_draft", round: 1, phase: "standup" },
      },
    ]);
    assert.equal(n, 1);
    assert.equal(ledger.observations[0]?.kind, "finding");
    assert.equal(ledger.observations[0]?.files?.[0], "scripts/a.py");
  });

  it("ingestExecutionTranscriptLines skips working-on noise", () => {
    const ledger = createEmptyLedger("run-y");
    ingestExecutionTranscriptLines(ledger, 1, [
      "[execution] agent-2 working on: foo",
      "[execution] agent-2 skipped: done already",
      "[execution] Complete: 0 done, 0 failed, 0 skipped.",
    ]);
    assert.equal(ledger.observations.length, 1);
    assert.equal(ledger.observations[0]?.kind, "skip");
  });

  it("wrapProgressContextForPrompt returns empty for blank", () => {
    assert.equal(wrapProgressContextForPrompt(""), "");
    assert.match(wrapProgressContextForPrompt("hello"), /SHARED RUN PROGRESS/);
  });
});