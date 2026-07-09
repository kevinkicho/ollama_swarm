import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { patchAgentForLiveSignals, viewAgentActivity } from "./agentActivityView.js";
import type { AgentState } from "../types.js";

describe("viewAgentActivity", () => {
  const ready: AgentState = { id: "agent-2", index: 2, status: "ready" };

  it("treats live streaming as busy when agent_state is still ready", () => {
    const view = viewAgentActivity(ready, undefined, {
      streamingMeta: { startedAt: 1_000, lastTextAt: 2_000, status: "live" },
      streamingText: '{"todos":',
    });
    assert.equal(view.isBusy, true);
    assert.equal(view.effectiveStatus, "thinking");
    assert.equal(view.phase, "streaming");
    assert.equal(view.statusWord, "streaming");
    assert.equal(view.busySince, 1_000);
  });

  it("treats agent_activity streaming as busy when agent_state lags", () => {
    const view = viewAgentActivity(ready, {
      phase: "streaming",
      ts: 5_000,
      startedAt: 1_000,
      label: "contract draft",
    });
    assert.equal(view.isBusy, true);
    assert.equal(view.effectiveStatus, "thinking");
    assert.equal(view.statusWord, "streaming");
  });
});

describe("patchAgentForLiveSignals", () => {
  it("promotes ready agents when streaming is live", () => {
    const ready: AgentState = { id: "agent-3", index: 3, status: "ready" };
    const patched = patchAgentForLiveSignals(ready, {
      streamingMeta: { startedAt: 500, lastTextAt: 600, status: "live" },
      streamingText: "partial",
    });
    assert.equal(patched?.status, "thinking");
    assert.equal(patched?.thinkingSince, 500);
  });

  it("does not patch agents already thinking", () => {
    const thinking: AgentState = {
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: 100,
    };
    assert.equal(
      patchAgentForLiveSignals(thinking, {
        streamingMeta: { startedAt: 500, lastTextAt: 600, status: "live" },
        streamingText: "x",
      }),
      undefined,
    );
  });
});