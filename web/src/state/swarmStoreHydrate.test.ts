import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSwarmStore } from "./store.js";
import {
  applyStatusSnapshotToStore,
  shouldDropTerminalGuardedEvent,
} from "./swarmStoreHydrate.js";
import type { SwarmStatusSnapshot, TranscriptEntry } from "../types.js";

describe("applyStatusSnapshotToStore", () => {
  it("hydrates transcript before phase so idle phase cannot wipe bubbles", () => {
    const store = createSwarmStore();
    const entries: TranscriptEntry[] = [
      { id: "t1", role: "agent", agentId: "agent-1", agentIndex: 1, text: "hello", ts: 1 },
      { id: "t2", role: "system", text: "system line", ts: 2 },
    ];
    const snap = {
      phase: "idle",
      round: 0,
      agents: [],
      transcript: entries,
      runId: "run-abc",
    } as SwarmStatusSnapshot;

    applyStatusSnapshotToStore(store, "run-abc", snap);

    const tx = store.getState().transcript;
    assert.ok(tx.length >= 2, "transcript entries must survive refresh-style hydrate");
    assert.ok(tx.some((t) => t.id === "t1"));
    assert.ok(tx.some((t) => t.id === "t2"));
  });

  it("prunes ghost agents not in council topology", () => {
    const store = createSwarmStore();
    store.getState().upsertAgent({ id: "agent-5", index: 5, status: "stopped" });
    store.getState().upsertAgent({ id: "agent-6", index: 6, status: "stopped" });

    const snap = {
      phase: "discussing",
      round: 0,
      agents: [
        { id: "agent-1", index: 1, status: "ready" },
        { id: "agent-2", index: 2, status: "thinking" },
        { id: "agent-3", index: 3, status: "ready" },
        { id: "agent-4", index: 4, status: "ready" },
        { id: "agent-5", index: 5, status: "stopped" },
        { id: "agent-6", index: 6, status: "stopped" },
      ],
      transcript: [],
      runId: "run-council",
      runConfig: {
        preset: "council",
        agentCount: 4,
        topology: {
          agents: [
            { index: 1, role: "drafter" },
            { index: 2, role: "drafter" },
            { index: 3, role: "drafter" },
            { index: 4, role: "drafter" },
          ],
        },
      },
    } as unknown as SwarmStatusSnapshot;

    applyStatusSnapshotToStore(store, "run-council", snap);
    const ids = Object.keys(store.getState().agents).sort();
    assert.deepEqual(ids, ["agent-1", "agent-2", "agent-3", "agent-4"]);
  });

  it("fills full council roster when status returns only one agent after crash", () => {
    const store = createSwarmStore();
    const snap = {
      phase: "failed",
      round: 0,
      agents: [{ id: "agent-2", index: 2, status: "stopped", model: "deepseek-v4-flash:cloud" }],
      transcript: [
        {
          id: "sys-ready",
          role: "system",
          text: "4/4 agents ready — models: deepseek-v4-flash:cloud, deepseek-v4-flash:cloud, deepseek-v4-flash:cloud, deepseek-v4-flash:cloud",
          ts: 1,
        },
      ],
      runId: "run-partial",
      runConfig: {
        preset: "council",
        agentCount: 4,
        topology: {
          agents: [
            { index: 1, model: "deepseek-v4-flash:cloud" },
            { index: 2, model: "deepseek-v4-flash:cloud" },
            { index: 3, model: "deepseek-v4-flash:cloud" },
            { index: 4, model: "deepseek-v4-flash:cloud" },
          ],
        },
      },
    } as unknown as SwarmStatusSnapshot;

    applyStatusSnapshotToStore(store, "run-partial", snap);
    const ids = Object.keys(store.getState().agents).sort();
    assert.deepEqual(ids, ["agent-1", "agent-2", "agent-3", "agent-4"]);
  });

  it("preserves thinkingSince from status snapshot for sidebar elapsed ticker", () => {
    const store = createSwarmStore();
    const snap = {
      phase: "seeding",
      round: 0,
      agents: [
        {
          id: "agent-3",
          index: 3,
          status: "thinking",
          thinkingSince: 1_700_000_000_000,
          activityLabel: "contract draft",
          model: "deepseek-v4-flash:cloud",
        },
      ],
      transcript: [],
      runId: "run-thinking",
    } as SwarmStatusSnapshot;

    applyStatusSnapshotToStore(store, "run-thinking", snap);
    const a = store.getState().agents["agent-3"];
    assert.equal(a?.status, "thinking");
    assert.equal(a?.thinkingSince, 1_700_000_000_000);
    assert.equal(a?.activityLabel, "contract draft");
  });

  it("applies active phase after transcript hydrate", () => {
    const store = createSwarmStore();
    const snap = {
      phase: "executing",
      round: 2,
      agents: [{ id: "agent-0", index: 0, status: "ready" }],
      transcript: [{ id: "e1", role: "system", text: "go", ts: 1 }],
      runId: "run-live",
    } as SwarmStatusSnapshot;

    applyStatusSnapshotToStore(store, "run-live", snap);
    assert.equal(store.getState().phase, "executing");
    assert.equal(store.getState().round, 2);
    assert.equal(store.getState().transcript.length, 2); // entry + RUN-START divider
  });
});

describe("shouldDropTerminalGuardedEvent", () => {
  const baseCtx = {
    statusHydrateOk: true,
    statusHasCompletedSummary: true,
    phase: "planning" as const,
    hasCompletedSummary: true,
  };

  it("never drops lifecycle events during active phases", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(
        { type: "agent_state", agent: { id: "agent-2", index: 2, status: "thinking" } },
        baseCtx,
      ),
      false,
    );
    assert.equal(
      shouldDropTerminalGuardedEvent(
        { type: "swarm_state", phase: "executing", round: 1 },
        { ...baseCtx, phase: "executing" },
      ),
      false,
    );
  });

  it("drops agent_state on completed historical views", () => {
    assert.equal(
      shouldDropTerminalGuardedEvent(
        { type: "agent_state", agent: { id: "agent-1", index: 1, status: "thinking" } },
        { ...baseCtx, phase: "completed", hasCompletedSummary: true },
      ),
      true,
    );
  });
});

describe("setPhase terminal", () => {
  it("clears thinking agents when run reaches completed/stopped/failed", () => {
    const store = createSwarmStore();
    store.getState().upsertAgent({
      id: "agent-1",
      index: 1,
      status: "thinking",
      thinkingSince: Date.now() - 60_000,
      model: "test",
    });
    store.getState().setPhase("completed", 0);
    const a = store.getState().agents["agent-1"];
    assert.equal(a?.status, "ready");
    assert.equal(a?.thinkingSince, undefined);
  });
});

describe("setPhase idle", () => {
  it("does not clear existing transcript on incidental idle", () => {
    const store = createSwarmStore();
    store.getState().hydrateTranscriptEntries([
      { id: "keep", role: "agent", text: "stay", ts: 1 },
    ]);
    store.getState().setPhase("idle", 0);
    assert.equal(store.getState().transcript.length, 1);
  });

  it("reset() still clears transcript", () => {
    const store = createSwarmStore();
    store.getState().hydrateTranscriptEntries([
      { id: "gone", role: "agent", text: "bye", ts: 1 },
    ]);
    store.getState().reset();
    assert.equal(store.getState().transcript.length, 0);
    assert.equal(store.getState().phase, "idle");
  });
});