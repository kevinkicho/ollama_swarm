// 2026-05-02 (persistence lever #2 first-cut): tests for the run-state
// persister. Pure-fs roundtrip against a temp directory so we exercise
// real atomic-write + debounce behavior, not mocks.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunStatePersister,
  findRecoverableRuns,
  isRecoverablePhase,
  loadSnapshot,
} from "./RunStatePersister.js";

describe("RunStatePersister — write side", () => {
  let workdir: string;
  let persister: RunStatePersister;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "run-state-persister-"));
    persister = new RunStatePersister(workdir);
  });

  function statePath(dir: string) { return `${dir}.run-state.json`; }
  function stateTmpPath(dir: string) { return `${dir}.run-state.json.tmp`; }

  afterEach(() => {
    persister.stop();
    rmSync(workdir, { recursive: true, force: true });
    // Clean up the sibling .run-state.json file (persister writes outside workdir)
    try { rmSync(`${workdir}.run-state.json`, { force: true }); } catch {}
    try { rmSync(`${workdir}.run-state.json.tmp`, { force: true }); } catch {}
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

  it("schedule + flush writes a complete snapshot to <clone>.run-state.json (sibling file)", async (t) => {
    persister.schedule(fixtureSnap());
    persister.flush();
    const written = readFileSync(`${workdir}.run-state.json`, "utf8");
    const parsed = JSON.parse(written);
    // T-Item-Recover (2026-05-04): bumped to 3 with optional contract (v3).
    assert.equal(parsed.schemaVersion, 3);
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
    const written = JSON.parse(readFileSync(`${workdir}.run-state.json`, "utf8"));
    assert.equal(written.phase, "phase-4");
  });

  it("flush() is a no-op when no snapshot is pending", () => {
    persister.flush();
    assert.equal(persister.getWriteCount(), 0);
    assert.ok(!existsSync(`${workdir}.run-state.json`), "no file should be written");
  });

  it("stop() flushes pending snapshot before clearing the timer", () => {
    persister.schedule(fixtureSnap({ phase: "terminal" }));
    // Without stop(), the snapshot would be trapped behind the 500ms
    // debounce. Stop must flush + write immediately.
    persister.stop();
    assert.equal(persister.getWriteCount(), 1);
    const written = JSON.parse(readFileSync(`${workdir}.run-state.json`, "utf8"));
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
    assert.ok(existsSync(`${workdir}.run-state.json`));
    assert.ok(!existsSync(`${workdir}.run-state.json.tmp`), "tmp file must be renamed (atomic)");
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

// T-Item-Recovery (2026-05-04): findRecoverableRuns + isRecoverablePhase
describe("findRecoverableRuns", () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "recoverable-runs-"));
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  function writeState(
    cloneName: string,
    state: Record<string, unknown>,
  ): string {
    const cloneDir = join(parent, cloneName);
    mkdirSync(cloneDir, { recursive: true });
    const file = join(cloneDir, "run-state.json");
    writeFileSync(file, JSON.stringify(state), "utf8");
    return cloneDir;
  }

  it("returns [] when no parent dirs match anything", () => {
    assert.deepEqual(findRecoverableRuns([]), []);
    assert.deepEqual(findRecoverableRuns(["/no/such/dir"]), []);
  });

  it("discovers a single valid run-state.json", () => {
    const cloneDir = writeState("repo-a", {
      schemaVersion: 1,
      runId: "run-abc",
      preset: "blackboard",
      phase: "executing",
      startedAt: 1000,
      lastEventAt: 2000,
      transcript: [{ id: "e1", role: "system", text: "hi", ts: 1500 }],
      amendments: [{ ts: 1800, text: "amend it" }],
    });
    const got = findRecoverableRuns([parent]);
    assert.equal(got.length, 1);
    assert.equal(got[0].clonePath, cloneDir);
    assert.equal(got[0].runId, "run-abc");
    assert.equal(got[0].preset, "blackboard");
    assert.equal(got[0].phase, "executing");
    assert.equal(got[0].transcriptLength, 1);
    assert.equal(got[0].amendmentCount, 1);
  });

  it("sorts results by lastEventAt descending (most-recent first)", () => {
    writeState("older", {
      schemaVersion: 1,
      runId: "older",
      preset: "blackboard",
      phase: "executing",
      startedAt: 1,
      lastEventAt: 1000,
      transcript: [],
      amendments: [],
    });
    writeState("newer", {
      schemaVersion: 1,
      runId: "newer",
      preset: "blackboard",
      phase: "executing",
      startedAt: 1,
      lastEventAt: 5000,
      transcript: [],
      amendments: [],
    });
    const got = findRecoverableRuns([parent]);
    assert.equal(got.length, 2);
    assert.equal(got[0].runId, "newer");
    assert.equal(got[1].runId, "older");
  });

  it("silently skips clones without run-state.json", () => {
    mkdirSync(join(parent, "no-state-here"), { recursive: true });
    writeState("has-state", {
      schemaVersion: 1,
      runId: "x",
      preset: "blackboard",
      phase: "executing",
      startedAt: 1,
      lastEventAt: 2,
      transcript: [],
      amendments: [],
    });
    const got = findRecoverableRuns([parent]);
    assert.equal(got.length, 1);
    assert.equal(got[0].runId, "x");
  });

  it("silently skips malformed JSON", () => {
    const cloneDir = join(parent, "broken");
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(cloneDir, "run-state.json"), "not json {", "utf8");
    assert.deepEqual(findRecoverableRuns([parent]), []);
  });

  it("silently skips JSON missing required fields", () => {
    writeState("missing-fields", {
      runId: "x",
      // missing preset, phase, startedAt, etc.
    });
    assert.deepEqual(findRecoverableRuns([parent]), []);
  });

  it("returns nothing when given a non-directory parent", () => {
    const filePath = join(parent, "not-a-dir.txt");
    writeFileSync(filePath, "x", "utf8");
    assert.deepEqual(findRecoverableRuns([filePath]), []);
  });
});

describe("isRecoverablePhase", () => {
  it("returns true for mid-flight phases", () => {
    assert.equal(isRecoverablePhase("executing"), true);
    assert.equal(isRecoverablePhase("discussing"), true);
    assert.equal(isRecoverablePhase("planning"), true);
    assert.equal(isRecoverablePhase("paused"), true);
    assert.equal(isRecoverablePhase("cloning"), true);
  });

  it("returns false for terminal phases", () => {
    assert.equal(isRecoverablePhase("completed"), false);
    assert.equal(isRecoverablePhase("stopped"), false);
    assert.equal(isRecoverablePhase("failed"), false);
  });

  it("returns true for unknown phases (fail-open: surface to user)", () => {
    assert.equal(isRecoverablePhase("some-future-phase"), true);
  });
});

// T-Item-Recover (2026-05-04): loadSnapshot tests
describe("loadSnapshot", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "load-snap-"));
  });
  afterEach(() => rmSync(workdir, { recursive: true, force: true }));

  it("returns null on missing file", () => {
    assert.equal(loadSnapshot(join(workdir, "nope.json")), null);
  });

  it("returns null on malformed JSON", () => {
    const file = join(workdir, "broken.json");
    writeFileSync(file, "{{{ not json", "utf8");
    assert.equal(loadSnapshot(file), null);
  });

  it("returns null on JSON missing required fields", () => {
    const file = join(workdir, "incomplete.json");
    writeFileSync(file, JSON.stringify({ runId: "x" }), "utf8");
    assert.equal(loadSnapshot(file), null);
  });

  it("loads a valid v1 snapshot (no runConfig)", () => {
    const file = join(workdir, "v1.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        runId: "r1",
        preset: "blackboard",
        phase: "executing",
        startedAt: 100,
        lastEventAt: 200,
        transcript: [],
        amendments: [],
      }),
      "utf8",
    );
    const snap = loadSnapshot(file);
    assert.ok(snap);
    assert.equal(snap!.runId, "r1");
    assert.equal(snap!.runConfig, undefined);
  });

  it("loads a v2 snapshot with embedded runConfig", () => {
    const file = join(workdir, "v2.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        runId: "r2",
        preset: "blackboard",
        phase: "executing",
        startedAt: 100,
        lastEventAt: 200,
        transcript: [{ id: "e1" }],
        amendments: [{ ts: 150, text: "amend" }],
        runConfig: {
          preset: "blackboard",
          repoUrl: "https://example.com/r",
          localPath: "/tmp/x",
          agentCount: 4,
          rounds: 10,
          model: "glm-5.1:cloud",
          extras: { dedicatedAuditor: true },
        },
      }),
      "utf8",
    );
    const snap = loadSnapshot(file);
    assert.ok(snap);
    assert.equal(snap!.schemaVersion, 2);
    assert.ok(snap!.runConfig);
    assert.equal(snap!.runConfig!.preset, "blackboard");
    assert.equal(snap!.runConfig!.agentCount, 4);
    assert.equal(snap!.runConfig!.extras?.dedicatedAuditor, true);
  });
});
