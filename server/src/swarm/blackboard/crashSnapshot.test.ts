import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCrashSnapshot,
  CRASH_SNAPSHOT_TRANSCRIPT_MAX,
  type CrashSnapshotInput,
} from "./crashSnapshot.js";
import type { TranscriptEntry } from "../../types.js";

function baseInput(overrides: Partial<CrashSnapshotInput> = {}): CrashSnapshotInput {
  return {
    error: new Error("boom"),
    phase: "executing",
    runStartedAt: 1000,
    crashedAt: 2000,
    config: {
      repoUrl: "https://example.com/r.git",
      localPath: "/tmp/r",
      agentCount: 3,
      rounds: 1,
      model: "glm-5.1:cloud",
      preset: "blackboard",
    },
    board: { todos: [], findings: [] },
    transcript: [],
    ...overrides,
  };
}

function entry(i: number): TranscriptEntry {
  return { id: `e${i}`, role: "system", text: `entry ${i}`, ts: i };
}

describe("buildCrashSnapshot", () => {
  it("captures message and stack when error is an Error", () => {
    const err = new Error("kaboom");
    const snap = buildCrashSnapshot(baseInput({ error: err }));
    assert.equal(snap.error.message, "kaboom");
    assert.ok(snap.error.stack, "stack should be present for Error");
    assert.match(snap.error.stack!, /kaboom/);
  });

  it("captures message without stack when error is a non-Error value", () => {
    const snap = buildCrashSnapshot(baseInput({ error: "plain string" }));
    assert.equal(snap.error.message, "plain string");
    assert.equal(snap.error.stack, undefined);
  });

  it("captures message without stack when error is an Error with no stack", () => {
    const err = new Error("no-stack");
    // Some runtime paths (e.g. reconstructed errors) can have stack undefined.
    err.stack = undefined;
    const snap = buildCrashSnapshot(baseInput({ error: err }));
    assert.equal(snap.error.message, "no-stack");
    assert.equal(snap.error.stack, undefined);
  });

  it("coerces null/undefined error to String()", () => {
    const snapNull = buildCrashSnapshot(baseInput({ error: null }));
    assert.equal(snapNull.error.message, "null");
    const snapUndef = buildCrashSnapshot(baseInput({ error: undefined }));
    assert.equal(snapUndef.error.message, "undefined");
  });

  it("serializes config when present", () => {
    const snap = buildCrashSnapshot(baseInput());
    assert.ok(snap.config);
    assert.equal(snap.config!.repoUrl, "https://example.com/r.git");
    assert.equal(snap.config!.preset, "blackboard");
  });

  it("sets config to null when missing", () => {
    const snap = buildCrashSnapshot(baseInput({ config: undefined }));
    assert.equal(snap.config, null);
  });

  it("preserves phase, runStartedAt, crashedAt verbatim", () => {
    const snap = buildCrashSnapshot(
      baseInput({ phase: "planning", runStartedAt: 123, crashedAt: 456 }),
    );
    assert.equal(snap.phase, "planning");
    assert.equal(snap.runStartedAt, 123);
    assert.equal(snap.crashedAt, 456);
  });

  it("allows runStartedAt to be undefined (crash before executing)", () => {
    const snap = buildCrashSnapshot(baseInput({ runStartedAt: undefined }));
    assert.equal(snap.runStartedAt, undefined);
  });

  it("keeps transcript verbatim when below the cap", () => {
    const transcript = Array.from({ length: 10 }, (_, i) => entry(i));
    const snap = buildCrashSnapshot(baseInput({ transcript }));
    assert.equal(snap.transcript.length, 10);
    assert.equal(snap.transcriptTruncated, false);
    assert.equal(snap.transcript[0].id, "e0");
    assert.equal(snap.transcript[9].id, "e9");
  });

  it("keeps transcript verbatim at exactly the cap (no truncation)", () => {
    const transcript = Array.from({ length: CRASH_SNAPSHOT_TRANSCRIPT_MAX }, (_, i) => entry(i));
    const snap = buildCrashSnapshot(baseInput({ transcript }));
    assert.equal(snap.transcript.length, CRASH_SNAPSHOT_TRANSCRIPT_MAX);
    assert.equal(snap.transcriptTruncated, false);
  });

  it("tail-truncates transcript when above the cap and flags truncation", () => {
    const total = CRASH_SNAPSHOT_TRANSCRIPT_MAX + 50;
    const transcript = Array.from({ length: total }, (_, i) => entry(i));
    const snap = buildCrashSnapshot(baseInput({ transcript }));
    assert.equal(snap.transcript.length, CRASH_SNAPSHOT_TRANSCRIPT_MAX);
    assert.equal(snap.transcriptTruncated, true);
    // Tail slice: last entry should be the newest one, first retained should
    // be `total - CRASH_SNAPSHOT_TRANSCRIPT_MAX`.
    assert.equal(snap.transcript[0].id, `e${total - CRASH_SNAPSHOT_TRANSCRIPT_MAX}`);
    assert.equal(snap.transcript[CRASH_SNAPSHOT_TRANSCRIPT_MAX - 1].id, `e${total - 1}`);
  });

  it("passes board through unchanged", () => {
    const board = {
      todos: [
        {
          id: "t1",
          description: "d",
          expectedFiles: ["a.ts"],
          status: "open" as const,
          replanCount: 0,
          createdBy: "agent-1",
          createdAt: 0,
        },
      ],
      findings: [],
    };
    const snap = buildCrashSnapshot(baseInput({ board }));
    assert.deepEqual(snap.board, board);
  });

  it("produces JSON-serializable output", () => {
    // A crash snapshot that can't JSON.stringify is useless. Assert the
    // output roundtrips cleanly.
    const snap = buildCrashSnapshot(baseInput());
    const roundtripped = JSON.parse(JSON.stringify(snap));
    assert.equal(roundtripped.error.message, "boom");
    assert.equal(roundtripped.phase, "executing");
  });
});
