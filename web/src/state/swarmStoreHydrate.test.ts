import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSyntheticRunStartDivider,
  hasRunStartDivider,
  shouldDropTerminalGuardedEvent,
  statusHasCompletedSummary,
  terminalPhaseFromSummary,
} from "./swarmStoreHydrate.js";
import type { SwarmEvent, SwarmStatusSnapshot } from "../types.js";

describe("shouldDropTerminalGuardedEvent", () => {
  const agentEv: SwarmEvent = {
    type: "agent_state",
    agent: { id: "a1", index: 1, status: "ready" },
  };

  it("allows agent_state for live runs (status ok, no completed summary)", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(agentEv, {
        statusHydrateOk: true,
        statusHasCompletedSummary: false,
        phase: "stopped",
        hasCompletedSummary: false,
      }),
      false,
    );
  });

  it("drops agent_state for completed historical views", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(agentEv, {
        statusHydrateOk: true,
        statusHasCompletedSummary: true,
        phase: "completed",
        hasCompletedSummary: true,
      }),
      true,
    );
  });

  it("drops swarm_state when phase is terminal and status was not live", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(
        { type: "swarm_state", phase: "planning", round: 1 },
        {
          statusHydrateOk: false,
          statusHasCompletedSummary: false,
          phase: "stopped",
          hasCompletedSummary: false,
        },
      ),
      true,
    );
  });

  it("passes through transcript_append regardless of terminal context", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(
        {
          type: "transcript_append",
          entry: { id: "t1", role: "system", text: "hi", ts: 1 },
        },
        {
          statusHydrateOk: true,
          statusHasCompletedSummary: true,
          phase: "completed",
          hasCompletedSummary: true,
        },
      ),
      false,
    );
  });
});

describe("statusHasCompletedSummary", () => {
  it("true when stopReason is set", () => {
    const snap = { summary: { stopReason: "completed" } } as SwarmStatusSnapshot;
    assert.equal(statusHasCompletedSummary(snap), true);
  });

  it("false when summary missing or no stopReason", () => {
    assert.equal(statusHasCompletedSummary({} as SwarmStatusSnapshot), false);
  });
});

describe("terminalPhaseFromSummary", () => {
  it("maps completed stopReason", () => {
    assert.equal(terminalPhaseFromSummary({ stopReason: "completed" }), "completed");
  });

  it("maps user stop to stopped", () => {
    assert.equal(terminalPhaseFromSummary({ stopReason: "user" }), "stopped");
  });

  it("returns null when no stopReason", () => {
    assert.equal(terminalPhaseFromSummary({}), null);
  });
});

describe("hasRunStartDivider", () => {
  it("detects divider for matching runId", () => {
    const tx = [
      buildSyntheticRunStartDivider("run-xyz", { preset: "council" }),
    ];
    assert.equal(hasRunStartDivider(tx, "run-xyz"), true);
    assert.equal(hasRunStartDivider(tx, "other"), false);
  });
});