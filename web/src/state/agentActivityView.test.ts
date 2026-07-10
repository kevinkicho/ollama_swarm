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

  it("does NOT treat stale activity streaming as busy when agent is ready and no stream", () => {
    // Aligns with dock: stale waiting/streaming must not resurrect busy.
    const view = viewAgentActivity(ready, {
      phase: "streaming",
      ts: 5_000,
      startedAt: 1_000,
      label: "contract draft",
    });
    assert.equal(view.isBusy, false);
    assert.equal(view.effectiveStatus, "ready");
    assert.equal(view.primaryLine, "ready");
  });

  it("keeps activity busy when agent_state is thinking", () => {
    const thinking: AgentState = {
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: 100,
      activityLabel: "standup",
    };
    const view = viewAgentActivity(thinking, {
      phase: "waiting",
      ts: 200,
      startedAt: 100,
      label: "standup",
    });
    assert.equal(view.isBusy, true);
    assert.equal(view.isWaiting, true);
    assert.match(view.primaryLine, /standup/);
    assert.match(view.primaryLine, /waiting/);
  });

  it("demotes sticky thinking when activity is done and stream is not live", () => {
    const thinking: AgentState = {
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: 100,
    };
    const view = viewAgentActivity(thinking, {
      phase: "done",
      ts: 9_000,
      startedAt: 100,
      label: "standup synthesis",
    });
    assert.equal(view.isBusy, false);
    assert.equal(view.effectiveStatus, "ready");
    assert.equal(view.primaryLine, "ready");
  });

  it("shows task label while streaming", () => {
    const thinking: AgentState = {
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: 100,
      activityLabel: "todo ab12cd34",
    };
    const view = viewAgentActivity(
      thinking,
      { phase: "streaming", ts: 200, startedAt: 100, label: "todo ab12cd34" },
      {
        streamingMeta: { startedAt: 100, lastTextAt: 150, status: "live" },
        streamingText: "partial",
        elapsed: "4s",
      },
    );
    assert.equal(view.isBusy, true);
    assert.match(view.primaryLine, /todo ab12cd34/);
    assert.match(view.primaryLine, /streaming/);
    assert.match(view.primaryLine, /4s/);
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

  it("does not promote from stale waiting activity alone", () => {
    const ready: AgentState = { id: "agent-3", index: 3, status: "ready" };
    assert.equal(
      patchAgentForLiveSignals(ready, {
        activity: { phase: "waiting", label: "x", startedAt: 1, ts: 1 },
      }),
      undefined,
    );
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
