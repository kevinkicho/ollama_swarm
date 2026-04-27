// V2 Step 6a tests: typed JSONL parser + run-slice splitter +
// state-derivation reducer. Pure logic — no disk I/O.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEventLog,
  splitIntoRuns,
  deriveRunState,
} from "./EventLogReaderV2.js";

describe("parseEventLog — basic cases", () => {
  it("parses a 2-line JSONL", () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { type: "_session_started" } }) +
      "\n" +
      JSON.stringify({ ts: 2, event: { type: "swarm_state", phase: "idle" } }) +
      "\n";
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 2);
    assert.equal(records[0].ts, 1);
    assert.equal(records[0].event.type, "_session_started");
    assert.equal(records[1].event.phase, "idle");
    assert.equal(malformed.length, 0);
  });

  it("skips blank lines without erroring", () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { type: "x" } }) +
      "\n\n\n" +
      JSON.stringify({ ts: 2, event: { type: "y" } });
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 2);
    assert.equal(malformed.length, 0);
  });

  it("collects malformed lines without losing valid ones", () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { type: "good" } }) +
      "\n{this is not json}\n" +
      JSON.stringify({ ts: 3, event: { type: "also-good" } });
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 2);
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].lineNumber, 2);
    assert.match(malformed[0].error, /JSON|json/);
  });

  it("rejects records missing ts or event", () => {
    const jsonl =
      JSON.stringify({ event: { type: "no-ts" } }) +
      "\n" +
      JSON.stringify({ ts: 1 }) +
      "\n" +
      JSON.stringify({ ts: 2, event: { type: "ok" } });
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 1);
    assert.equal(malformed.length, 2);
  });

  it("rejects events without a string `type`", () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { foo: "bar" } }) + "\n";
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 0);
    assert.equal(malformed.length, 1);
    assert.match(malformed[0].error, /type/);
  });

  it("handles a partial last line gracefully (server killed mid-write)", () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { type: "ok" } }) +
      '\n{"ts": 2, "event": {"type": "incomp';
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(records.length, 1);
    assert.equal(malformed.length, 1);
  });
});

describe("splitIntoRuns — slice boundaries", () => {
  it("starts a new slice on _session_started", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "_session_started" } }),
        JSON.stringify({ ts: 2, event: { type: "x" } }),
        JSON.stringify({ ts: 10, event: { type: "_session_started" } }),
        JSON.stringify({ ts: 11, event: { type: "y" } }),
      ].join("\n"),
    ).records;
    const slices = splitIntoRuns(records);
    assert.equal(slices.length, 2);
    assert.equal(slices[0].records.length, 2);
    assert.equal(slices[1].records.length, 2);
    assert.equal(slices[0].isSessionBoundary, true);
    assert.equal(slices[1].isSessionBoundary, true);
  });

  it("starts a new slice on run_started even within the same session", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "_session_started" } }),
        JSON.stringify({ ts: 2, event: { type: "run_started", runId: "r1" } }),
        JSON.stringify({ ts: 3, event: { type: "x" } }),
        JSON.stringify({ ts: 10, event: { type: "run_started", runId: "r2" } }),
        JSON.stringify({ ts: 11, event: { type: "y" } }),
      ].join("\n"),
    ).records;
    const slices = splitIntoRuns(records);
    assert.equal(slices.length, 3);
    assert.equal(slices[0].isSessionBoundary, true);
    assert.equal(slices[1].isSessionBoundary, false);
    assert.equal(slices[2].isSessionBoundary, false);
  });

  it("buckets pre-marker records into a synthetic slice (partial log)", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "x" } }),
        JSON.stringify({ ts: 2, event: { type: "y" } }),
      ].join("\n"),
    ).records;
    const slices = splitIntoRuns(records);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].records.length, 2);
    assert.equal(slices[0].isSessionBoundary, false);
  });

  it("startedAt + endedAt span the slice", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 100, event: { type: "_session_started" } }),
        JSON.stringify({ ts: 200, event: { type: "x" } }),
        JSON.stringify({ ts: 350, event: { type: "y" } }),
      ].join("\n"),
    ).records;
    const slices = splitIntoRuns(records);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].startedAt, 100);
    assert.equal(slices[0].endedAt, 350);
  });

  it("returns empty array on empty record list", () => {
    assert.deepEqual(splitIntoRuns([]), []);
  });
});

describe("deriveRunState — per-run snapshot", () => {
  it("extracts runId + preset from run_started", () => {
    const records = parseEventLog(
      JSON.stringify({
        ts: 1,
        event: { type: "run_started", runId: "abc", preset: "blackboard" },
      }) + "\n",
    ).records;
    const slice = splitIntoRuns(records)[0];
    const state = deriveRunState(slice);
    assert.equal(state.runId, "abc");
    assert.equal(state.preset, "blackboard");
    assert.equal(state.startedAt, 1);
  });

  it("tracks final phase as the last swarm_state", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "run_started" } }),
        JSON.stringify({ ts: 2, event: { type: "swarm_state", phase: "planning" } }),
        JSON.stringify({ ts: 3, event: { type: "swarm_state", phase: "executing" } }),
        JSON.stringify({ ts: 4, event: { type: "swarm_state", phase: "completed" } }),
      ].join("\n"),
    ).records;
    const state = deriveRunState(splitIntoRuns(records)[0]);
    assert.equal(state.finalPhase, "completed");
  });

  it("counts transcript_append + agent_state events", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "run_started" } }),
        JSON.stringify({ ts: 2, event: { type: "transcript_append" } }),
        JSON.stringify({ ts: 3, event: { type: "transcript_append" } }),
        JSON.stringify({ ts: 4, event: { type: "agent_state" } }),
        JSON.stringify({ ts: 5, event: { type: "transcript_append" } }),
      ].join("\n"),
    ).records;
    const state = deriveRunState(splitIntoRuns(records)[0]);
    assert.equal(state.transcriptCount, 3);
    assert.equal(state.agentStateUpdates, 1);
  });

  it("collects error messages", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "run_started" } }),
        JSON.stringify({ ts: 2, event: { type: "error", message: "first error" } }),
        JSON.stringify({ ts: 3, event: { type: "error", message: "second error" } }),
      ].join("\n"),
    ).records;
    const state = deriveRunState(splitIntoRuns(records)[0]);
    assert.deepEqual(state.errors, ["first error", "second error"]);
  });

  it("sets hasSummary + finishedAt on run_summary event", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "run_started" } }),
        JSON.stringify({ ts: 100, event: { type: "run_summary" } }),
      ].join("\n"),
    ).records;
    const state = deriveRunState(splitIntoRuns(records)[0]);
    assert.equal(state.hasSummary, true);
    assert.equal(state.finishedAt, 100);
  });

  it("future event types are silently ignored (forward-compatible)", () => {
    const records = parseEventLog(
      [
        JSON.stringify({ ts: 1, event: { type: "run_started" } }),
        JSON.stringify({ ts: 2, event: { type: "future_event_v3" } }),
        JSON.stringify({ ts: 3, event: { type: "transcript_append" } }),
      ].join("\n"),
    ).records;
    const state = deriveRunState(splitIntoRuns(records)[0]);
    assert.equal(state.transcriptCount, 1);
    assert.equal(state.errors.length, 0);
  });
});

describe("EventLogReaderV2 — end-to-end pipeline", () => {
  it("realistic 1-run log: parse → split → derive", () => {
    const jsonl = [
      JSON.stringify({ ts: 1000, event: { type: "_session_started" } }),
      JSON.stringify({ ts: 1100, event: { type: "run_started", runId: "r1", preset: "blackboard" } }),
      JSON.stringify({ ts: 1200, event: { type: "swarm_state", phase: "spawning" } }),
      JSON.stringify({ ts: 1300, event: { type: "swarm_state", phase: "planning" } }),
      JSON.stringify({ ts: 1400, event: { type: "transcript_append" } }),
      JSON.stringify({ ts: 1500, event: { type: "swarm_state", phase: "executing" } }),
      JSON.stringify({ ts: 1600, event: { type: "transcript_append" } }),
      JSON.stringify({ ts: 1700, event: { type: "transcript_append" } }),
      JSON.stringify({ ts: 1800, event: { type: "swarm_state", phase: "completed" } }),
      JSON.stringify({ ts: 1900, event: { type: "run_summary" } }),
    ].join("\n");
    const { records, malformed } = parseEventLog(jsonl);
    assert.equal(malformed.length, 0);
    const slices = splitIntoRuns(records);
    // 2 slices: session_started boundary + run_started
    assert.equal(slices.length, 2);
    const runSlice = slices[1];
    const state = deriveRunState(runSlice);
    assert.equal(state.runId, "r1");
    assert.equal(state.preset, "blackboard");
    assert.equal(state.startedAt, 1100);
    assert.equal(state.finishedAt, 1900);
    assert.equal(state.finalPhase, "completed");
    assert.equal(state.transcriptCount, 3);
    assert.equal(state.hasSummary, true);
    assert.equal(state.errors.length, 0);
  });
});
