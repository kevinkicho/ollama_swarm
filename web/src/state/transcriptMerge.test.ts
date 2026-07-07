import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeTranscriptEntry, type TranscriptMergeSlice } from "./transcriptMerge.js";
import { createSwarmStore } from "./store.js";
import type { TranscriptEntry } from "../types.js";

const emptySlice = (): TranscriptMergeSlice => ({
  transcript: [],
  streaming: {},
  streamingMeta: {},
});

const RUN_START_A =
  "▸▸RUN-START▸▸|runId=run-abc|preset=blackboard|plannerModel=m1|workerModel=m2|agentCount=3|repoUrl=";

describe("mergeTranscriptEntry", () => {
  it("dedupes duplicate RUN-START dividers for the same runId (different ids)", () => {
    let slice = emptySlice();
    const first: TranscriptEntry = {
      id: "div-1",
      role: "system",
      text: RUN_START_A,
      ts: 1,
    };
    const second: TranscriptEntry = {
      id: "div-2",
      role: "system",
      text: RUN_START_A,
      ts: 2,
    };
    slice = mergeTranscriptEntry(slice, first)!;
    assert.equal(mergeTranscriptEntry(slice, second), null);
    assert.equal(slice.transcript.length, 1);
    assert.equal(slice.transcript[0]!.id, "div-1");
  });

  it("dedupes duplicate seed-prefix system lines on hydrate-style batch", () => {
    let slice = emptySlice();
    const seed1: TranscriptEntry = {
      id: "s1",
      role: "system",
      text: "Memory: surfaced 3 prior failures",
      ts: 1,
    };
    const seed2: TranscriptEntry = {
      id: "s2",
      role: "system",
      text: "Memory: surfaced 3 prior failures (phase 2 re-emit)",
      ts: 2,
    };
    slice = mergeTranscriptEntry(slice, seed1)!;
    assert.equal(mergeTranscriptEntry(slice, seed2), null);
    assert.equal(slice.transcript.length, 1);
  });

  it("moves RUN-START divider to index 0 when merged after pipeline line", () => {
    let slice = emptySlice();
    const pipeline: TranscriptEntry = {
      id: "p1",
      role: "system",
      text: "[Pipeline] Starting phase 1",
      ts: 2,
    };
    const divider: TranscriptEntry = {
      id: "d1",
      role: "system",
      text: RUN_START_A,
      ts: 1,
    };
    slice = mergeTranscriptEntry(slice, pipeline)!;
    slice = mergeTranscriptEntry(slice, divider)!;
    assert.equal(slice.transcript[0]!.id, "d1");
    assert.equal(slice.transcript[1]!.id, "p1");
  });

  it("skips duplicate entry ids", () => {
    const entry: TranscriptEntry = { id: "x", role: "agent", text: "hello", ts: 1 };
    let slice = mergeTranscriptEntry(emptySlice(), entry)!;
    assert.equal(mergeTranscriptEntry(slice, entry), null);
  });

  it("preserves agentIndex on flushed agent-stream snapshot", () => {
    let slice: TranscriptMergeSlice = {
      transcript: [],
      streaming: { "agent-4": "[{\"issue\":\"x\"}]" },
      streamingMeta: {
        "agent-4": { startedAt: 100, lastTextAt: 200, status: "live" },
      },
    };
    const final: TranscriptEntry = {
      id: "a4-final",
      role: "agent",
      agentId: "agent-4",
      agentIndex: 4,
      text: "different final response",
      ts: 300,
    };
    slice = mergeTranscriptEntry(slice, final)!;
    const stream = slice.transcript.find((t) => t.role === "agent-stream");
    assert.ok(stream);
    assert.equal(stream!.agentIndex, 4);
    assert.equal(slice.transcript.length, 2);
  });

  it("skips redundant agent-stream when streamed text matches final entry", () => {
    const json = "[{\"issue\":\"duplicate\"}]";
    let slice: TranscriptMergeSlice = {
      transcript: [],
      streaming: { "agent-4": json },
      streamingMeta: {
        "agent-4": { startedAt: 100, lastTextAt: 200, status: "live" },
      },
    };
    const final: TranscriptEntry = {
      id: "a4-final",
      role: "agent",
      agentId: "agent-4",
      agentIndex: 4,
      text: json,
      ts: 300,
    };
    slice = mergeTranscriptEntry(slice, final)!;
    assert.equal(slice.transcript.length, 1);
    assert.equal(slice.transcript[0]!.role, "agent");
    assert.equal(slice.streaming["agent-4"], undefined);
  });

  it("dedupes worker_skip by reason text", () => {
    let slice = emptySlice();
    const skip1: TranscriptEntry = {
      id: "sk1",
      role: "agent",
      text: "skip",
      ts: 1,
      summary: { kind: "worker_skip", reason: "already present" } as TranscriptEntry["summary"],
    };
    const skip2: TranscriptEntry = {
      id: "sk2",
      role: "agent",
      text: "skip again",
      ts: 2,
      summary: { kind: "worker_skip", reason: "already present" } as TranscriptEntry["summary"],
    };
    slice = mergeTranscriptEntry(slice, skip1)!;
    assert.equal(mergeTranscriptEntry(slice, skip2), null);
  });
});

describe("hydrateTranscriptEntries via store", () => {
  it("batch hydrate applies the same dedup rules as appendEntry", () => {
    const store = createSwarmStore();
    const entries: TranscriptEntry[] = [
      { id: "t-pipe", role: "system", text: "[Pipeline] kickoff", ts: 10 },
      { id: "t-div", role: "system", text: RUN_START_A, ts: 5 },
      { id: "t-div-dup", role: "system", text: RUN_START_A, ts: 6 },
      { id: "t-seed", role: "system", text: "Seed: directive context", ts: 11 },
      { id: "t-seed-dup", role: "system", text: "Seed: re-emitted", ts: 12 },
    ];
    store.getState().hydrateTranscriptEntries(entries);
    const tx = store.getState().transcript;
    assert.equal(tx.length, 3, "divider + pipeline + one seed");
    assert.equal(tx[0]!.id, "t-div");
    assert.ok(tx.some((t) => t.id === "t-pipe"));
    assert.ok(tx.some((t) => t.id === "t-seed"));
    assert.ok(!tx.some((t) => t.id === "t-div-dup"));
    assert.ok(!tx.some((t) => t.id === "t-seed-dup"));
  });

  it("hydrate then appendEntry still dedupes RUN-START", () => {
    const store = createSwarmStore();
    store.getState().hydrateTranscriptEntries([
      { id: "h1", role: "system", text: RUN_START_A, ts: 1 },
    ]);
    store.getState().appendEntry({
      id: "live1",
      role: "system",
      text: RUN_START_A,
      ts: 2,
    });
    assert.equal(store.getState().transcript.length, 1);
  });
});