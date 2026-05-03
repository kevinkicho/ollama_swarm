// 2026-05-02 (persistence lever #2 first-cut): tests for the run-state
// persister. Pure-fs roundtrip against a temp directory so we exercise
// real atomic-write + debounce behavior, not mocks.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStatePersister } from "./RunStatePersister.js";

describe("RunStatePersister — write side", () => {
  let workdir: string;
  let persister: RunStatePersister;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "run-state-persister-"));
    persister = new RunStatePersister(workdir);
  });

  afterEach(() => {
    persister.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  function fixtureSnap(overrides: Partial<Parameters<typeof persister.schedule>[0]> = {}) {
    return {
      runId: "run-1",
      preset: "blackboard",
      phase: "discussing",
      startedAt: 1234567890,
      transcript: [{ id: "t1", role: "system", text: "hi", ts: 1234567891 }],
      amendments: [{ ts: 1234567892, text: "focus on retry" }],
      ...overrides,
    };
  }

  it("schedule + flush writes a complete snapshot to <clone>/run-state.json", async (t) => {
    persister.schedule(fixtureSnap());
    persister.flush();
    const written = readFileSync(join(workdir, "run-state.json"), "utf8");
    const parsed = JSON.parse(written);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.runId, "run-1");
    assert.equal(parsed.preset, "blackboard");
    assert.equal(parsed.phase, "discussing");
    assert.equal(parsed.startedAt, 1234567890);
    assert.ok(parsed.lastEventAt > 0, "lastEventAt must be stamped");
    assert.equal(parsed.transcript.length, 1);
    assert.equal(parsed.amendments.length, 1);
    void t;
  });

  it("debounces multiple schedule() calls into one fsync", async () => {
    // Fire 5 events back-to-back; the persister should collapse them.
    for (let i = 0; i < 5; i++) {
      persister.schedule(fixtureSnap({ phase: `phase-${i}` }));
    }
    // Wait past the 500ms debounce window.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(persister.getWriteCount(), 1, "5 schedule calls in <500ms must collapse to 1 write");
    // Last-snapshot-wins: phase-4 (the last one) is what landed.
    const written = JSON.parse(readFileSync(join(workdir, "run-state.json"), "utf8"));
    assert.equal(written.phase, "phase-4");
  });

  it("flush() is a no-op when no snapshot is pending", () => {
    persister.flush();
    assert.equal(persister.getWriteCount(), 0);
    assert.ok(!existsSync(join(workdir, "run-state.json")), "no file should be written");
  });

  it("stop() flushes pending snapshot before clearing the timer", () => {
    persister.schedule(fixtureSnap({ phase: "terminal" }));
    // Without stop(), the snapshot would be trapped behind the 500ms
    // debounce. Stop must flush + write immediately.
    persister.stop();
    assert.equal(persister.getWriteCount(), 1);
    const written = JSON.parse(readFileSync(join(workdir, "run-state.json"), "utf8"));
    assert.equal(written.phase, "terminal");
  });

  it("stop() is idempotent — second call is a no-op", () => {
    persister.schedule(fixtureSnap());
    persister.stop();
    const after1 = persister.getWriteCount();
    persister.stop();
    assert.equal(persister.getWriteCount(), after1, "second stop must not re-write");
  });

  it("uses atomic write (tmp + rename) — no partial files visible", () => {
    persister.schedule(fixtureSnap());
    persister.flush();
    // After flush, ONLY the final file should exist; the tmp file
    // should have been renamed away.
    assert.ok(existsSync(join(workdir, "run-state.json")));
    assert.ok(!existsSync(join(workdir, "run-state.json.tmp")), "tmp file must be renamed (atomic)");
  });

  it("write failure on an unwritable path is silenced after the first error log", () => {
    // Construct against a path that doesn't exist + can't be created
    // with the user's permissions. Hard to make truly unwritable
    // cross-platform; instead, trigger by writing to a path with a
    // null byte (invalid filename on every OS).
    const bad = new RunStatePersister("\0invalid-path");
    // Multiple scheduled writes — should never throw out of schedule/flush.
    bad.schedule({ runId: "r", preset: "p", phase: "x", startedAt: 1, transcript: [], amendments: [] });
    bad.flush();
    bad.schedule({ runId: "r", preset: "p", phase: "x", startedAt: 1, transcript: [], amendments: [] });
    bad.flush();
    // Test passes if we got here without throwing.
    assert.equal(bad.getWriteCount(), 0, "no successful writes against an invalid path");
  });
});
