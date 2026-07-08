import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunHousekeeper } from "./runHousekeeper.js";
import type { TranscriptEntry } from "../types.js";

describe("RunHousekeeper", () => {
  it("emits an alert when phrase repetition is detected past 10k chars", () => {
    const entries: TranscriptEntry[] = [];
    const hk = new RunHousekeeper((e) => entries.push(e), "run-test");
    const phrase = "I'll use the IMF Data API: https://www.imf.org/-/api/ ";
    const text = "x".repeat(10_000) + phrase.repeat(10);
    hk.observe("agent-5", 5, text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, "agent-0");
    assert.equal(entries[0].summary?.kind, "housekeeper_alert");
    if (entries[0].summary?.kind === "housekeeper_alert") {
      assert.equal(entries[0].summary.watchedAgentIndex, 5);
      assert.ok(entries[0].summary.repeatCount >= 8);
    }
  });

  it("does not alert on short streams", () => {
    const entries: TranscriptEntry[] = [];
    const hk = new RunHousekeeper((e) => entries.push(e), "run-test");
    hk.observe("agent-2", 2, "short".repeat(100));
    assert.equal(entries.length, 0);
  });

  it("resets per-turn state", () => {
    const entries: TranscriptEntry[] = [];
    const hk = new RunHousekeeper((e) => entries.push(e), "run-test");
    const phrase = "loop-phrase-".repeat(4);
    const text = "y".repeat(10_000) + phrase.repeat(12);
    hk.observe("agent-3", 3, text);
    hk.resetTurn("agent-3");
    hk.observe("agent-3", 3, text);
    assert.equal(entries.length, 2);
  });
});