import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSwarmStore } from "./store.js";
import { applyStatusSnapshotToStore } from "./swarmStoreHydrate.js";
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