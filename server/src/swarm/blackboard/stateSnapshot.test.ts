import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildStateSnapshot,
  readBlackboardStateSnapshot,
  STATE_SNAPSHOT_DEBOUNCE_MS,
  STATE_SNAPSHOT_VERSION,
  type BlackboardStateSnapshotInput,
} from "./stateSnapshot.js";
import type { BoardSnapshot, ExitContract } from "./types.js";

function emptyBoard(): BoardSnapshot {
  return { todos: [], findings: [] };
}

function baseInput(
  overrides: Partial<BlackboardStateSnapshotInput> = {},
): BlackboardStateSnapshotInput {
  return {
    writtenAt: 1_700_000_000_000,
    phase: "executing",
    round: 2,
    runBootedAt: 1_700_000_000_000 - 60_000,
    runStartedAt: 1_700_000_000_000 - 30_000,
    activeElapsedMs: 30_000,
    config: {
      repoUrl: "https://github.com/x/y",
      localPath: "/tmp/y",
      agentCount: 3,
      rounds: 5,
      model: "glm-5.1:cloud",
      preset: "blackboard",
    },
    contract: {
      missionStatement: "Ship the quick start.",
      criteria: [
        {
          id: "c1",
          description: "README has Quick Start",
          expectedFiles: ["README.md"],
          status: "unmet",
          addedAt: 1_700_000_000_000 - 40_000,
        },
      ],
    },
    board: emptyBoard(),
    perAgent: [
      {
        agentId: "agent-1",
        agentIndex: 1,
        turnsTaken: 3,
        tokensIn: null,
        tokensOut: null,
        totalAttempts: 3,
        totalRetries: 0,
        successfulAttempts: 3,
        meanLatencyMs: 1_200,
        p50LatencyMs: 1_100,
        p95LatencyMs: 1_500,
      },
    ],
    staleEventCount: 0,
    auditInvocations: 1,
    agentRoster: [{ agentId: "agent-1", agentIndex: 1 }],
    // terminationReason / completionDetail omitted — covered by the
    // "optional fields absent" test. Setting them to `undefined`
    // explicitly would trip the JSON round-trip check (JSON.stringify
    // drops undefined keys).
    ...overrides,
  };
}

describe("buildStateSnapshot", () => {
  it("stamps STATE_SNAPSHOT_VERSION on the output envelope", () => {
    const snap = buildStateSnapshot(baseInput());
    assert.equal(snap.version, STATE_SNAPSHOT_VERSION);
    assert.equal(typeof snap.version, "number");
  });

  it("passes every input field through unchanged", () => {
    const input = baseInput();
    const snap = buildStateSnapshot(input);
    assert.equal(snap.writtenAt, input.writtenAt);
    assert.equal(snap.phase, input.phase);
    assert.equal(snap.round, input.round);
    assert.equal(snap.runBootedAt, input.runBootedAt);
    assert.equal(snap.runStartedAt, input.runStartedAt);
    assert.equal(snap.activeElapsedMs, input.activeElapsedMs);
    assert.equal(snap.staleEventCount, input.staleEventCount);
    assert.equal(snap.auditInvocations, input.auditInvocations);
    assert.deepEqual(snap.agentRoster, input.agentRoster);
    assert.deepEqual(snap.perAgent, input.perAgent);
    assert.deepEqual(snap.config, input.config);
    assert.deepEqual(snap.contract, input.contract);
    assert.deepEqual(snap.board, input.board);
  });

  it("handles optional fields being absent", () => {
    const input: BlackboardStateSnapshotInput = {
      writtenAt: 123,
      phase: "planning",
      round: 0,
      board: emptyBoard(),
      perAgent: [],
      staleEventCount: 0,
      auditInvocations: 0,
      agentRoster: [],
    };
    const snap = buildStateSnapshot(input);
    assert.equal(snap.version, STATE_SNAPSHOT_VERSION);
    assert.equal(snap.runBootedAt, undefined);
    assert.equal(snap.runStartedAt, undefined);
    assert.equal(snap.activeElapsedMs, undefined);
    assert.equal(snap.config, undefined);
    assert.equal(snap.contract, undefined);
    assert.equal(snap.terminationReason, undefined);
    assert.equal(snap.completionDetail, undefined);
  });

  it("serializes to stable JSON — same input produces same JSON", () => {
    const a = buildStateSnapshot(baseInput());
    const b = buildStateSnapshot(baseInput());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("is JSON-round-trippable (no Dates, no functions, etc.)", () => {
    const snap = buildStateSnapshot(baseInput());
    const serialized = JSON.stringify(snap);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(parsed, snap);
  });

  it("carries terminationReason + completionDetail when the run is ending", () => {
    const input = baseInput({
      phase: "completed",
      terminationReason: "wall-clock cap reached (480 min)",
      completionDetail: "all contract criteria satisfied",
    });
    const snap = buildStateSnapshot(input);
    assert.equal(snap.phase, "completed");
    assert.equal(snap.terminationReason, "wall-clock cap reached (480 min)");
    assert.equal(snap.completionDetail, "all contract criteria satisfied");
  });

  it("preserves agentRoster array ordering (1-based indexes ascending)", () => {
    const input = baseInput({
      agentRoster: [
        { agentId: "agent-1", agentIndex: 1 },
        { agentId: "agent-2", agentIndex: 2 },
        { agentId: "agent-3", agentIndex: 3 },
      ],
    });
    const snap = buildStateSnapshot(input);
    assert.deepEqual(snap.agentRoster.map((a) => a.agentIndex), [1, 2, 3]);
  });
});

describe("STATE_SNAPSHOT_DEBOUNCE_MS", () => {
  it("is a positive finite number", () => {
    assert.ok(Number.isFinite(STATE_SNAPSHOT_DEBOUNCE_MS));
    assert.ok(STATE_SNAPSHOT_DEBOUNCE_MS > 0);
  });

  it("is at least 100ms (meaningful debounce) and at most 5s (bounded staleness)", () => {
    // Outside these bounds and either the runner thrashes on writes or
    // the on-disk view lags the in-memory view by enough to matter.
    assert.ok(STATE_SNAPSHOT_DEBOUNCE_MS >= 100);
    assert.ok(STATE_SNAPSHOT_DEBOUNCE_MS <= 5_000);
  });
});

// Unit 51: read path for the resume-contract flow.
describe("readBlackboardStateSnapshot", () => {
  function contract(): ExitContract {
    return {
      missionStatement: "Test mission.",
      criteria: [
        { id: "c1", description: "do x", expectedFiles: ["x.md"], status: "met", addedAt: 1 },
        { id: "c2", description: "do y", expectedFiles: [], status: "unmet", addedAt: 1 },
      ],
    };
  }

  it("returns null when blackboard-state.json doesn't exist", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-read-none-"));
    try {
      assert.equal(await readBlackboardStateSnapshot(tmp), null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the file is unparseable JSON", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-read-bad-"));
    try {
      await fs.writeFile(path.join(tmp, "blackboard-state.json"), "{not json", "utf8");
      assert.equal(await readBlackboardStateSnapshot(tmp), null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the snapshot lacks a contract", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-read-nocon-"));
    try {
      const snap = buildStateSnapshot({
        writtenAt: 100,
        phase: "executing",
        round: 0,
        board: { todos: [], findings: [] },
        perAgent: [],
        staleEventCount: 0,
        auditInvocations: 0,
        agentRoster: [],
      });
      await fs.writeFile(
        path.join(tmp, "blackboard-state.json"),
        JSON.stringify(snap),
        "utf8",
      );
      // Pre-contract crashes are not useful for resume; helper rejects.
      assert.equal(await readBlackboardStateSnapshot(tmp), null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when the version field doesn't match STATE_SNAPSHOT_VERSION", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-read-vermismatch-"));
    try {
      const stale = {
        version: STATE_SNAPSHOT_VERSION + 99,
        writtenAt: 1,
        phase: "executing",
        round: 0,
        board: { todos: [], findings: [] },
        perAgent: [],
        staleEventCount: 0,
        auditInvocations: 0,
        agentRoster: [],
        contract: contract(),
      };
      await fs.writeFile(
        path.join(tmp, "blackboard-state.json"),
        JSON.stringify(stale),
        "utf8",
      );
      // Future schema bumps are gated — better to fall back to
      // first-pass-contract than to install a contract whose shape
      // we don't fully understand.
      assert.equal(await readBlackboardStateSnapshot(tmp), null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads back a snapshot with contract + tier state intact", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snap-read-good-"));
    try {
      const snap = buildStateSnapshot({
        writtenAt: 1_000,
        phase: "executing",
        round: 3,
        board: { todos: [], findings: [] },
        perAgent: [],
        staleEventCount: 0,
        auditInvocations: 2,
        agentRoster: [{ agentId: "agent-1", agentIndex: 1 }],
        contract: contract(),
        currentTier: 2,
        tiersCompleted: 1,
        tierHistory: [
          {
            tier: 1,
            missionStatement: "Test mission.",
            criteriaTotal: 2,
            criteriaMet: 2,
            criteriaWontDo: 0,
            criteriaUnmet: 0,
            wallClockMs: 60_000,
            startedAt: 0,
            endedAt: 60_000,
          },
        ],
      });
      await fs.writeFile(
        path.join(tmp, "blackboard-state.json"),
        JSON.stringify(snap),
        "utf8",
      );
      const got = await readBlackboardStateSnapshot(tmp);
      assert.ok(got);
      assert.equal(got!.version, STATE_SNAPSHOT_VERSION);
      assert.equal(got!.contract!.missionStatement, "Test mission.");
      assert.equal(got!.contract!.criteria.length, 2);
      assert.equal(got!.currentTier, 2);
      assert.equal(got!.tiersCompleted, 1);
      assert.equal(got!.tierHistory!.length, 1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
