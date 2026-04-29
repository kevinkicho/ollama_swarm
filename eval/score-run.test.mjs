// #297: tests for the scoreRun() function in run-eval.mjs.
// Exercises the scoring math (completion + throughput + efficiency
// + conformance) across the common shapes a summary.json can take.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreRun } from "./run-eval.mjs";

describe("scoreRun — defensive cases", () => {
  it("returns 0 total for null summary", () => {
    const r = scoreRun(null, { id: "x", expectFilesChanged: false });
    assert.equal(r.total, 0);
    assert.equal(r.notes, "no summary");
  });

  it("returns 0 total for non-object summary", () => {
    const r = scoreRun("not a summary", { id: "x", expectFilesChanged: false });
    assert.equal(r.total, 0);
  });
});

describe("scoreRun — completion component (40 pts)", () => {
  const baseSummary = {
    wallClockMs: 60_000,
    totalPromptTokens: 10_000,
    totalResponseTokens: 1_000,
    filesChanged: 0,
    transcript: [],
    agents: [],
  };
  const task = { id: "x", expectFilesChanged: false };

  it("awards 40 for stopReason=completed", () => {
    const r = scoreRun({ ...baseSummary, stopReason: "completed" }, task);
    assert.equal(r.components.completion, 40);
  });

  it("awards 20 for stopReason=user (manual stop)", () => {
    const r = scoreRun({ ...baseSummary, stopReason: "user" }, task);
    assert.equal(r.components.completion, 20);
  });

  it("awards 20 for stopReason=wall_clock", () => {
    const r = scoreRun({ ...baseSummary, stopReason: "wall_clock" }, task);
    assert.equal(r.components.completion, 20);
  });

  it("awards 0 for stopReason=failed", () => {
    const r = scoreRun({ ...baseSummary, stopReason: "failed" }, task);
    assert.equal(r.components.completion, 0);
  });

  it("awards 10 for unknown stopReason (defensive)", () => {
    const r = scoreRun({ ...baseSummary, stopReason: "weird" }, task);
    assert.equal(r.components.completion, 10);
  });
});

describe("scoreRun — throughput component (30 pts)", () => {
  it("for code tasks, scales on filesChanged (1 file = 6, 5+ = 30)", () => {
    const codeTask = { id: "c", expectFilesChanged: true };
    const base = { stopReason: "completed", wallClockMs: 60_000, totalPromptTokens: 10_000, totalResponseTokens: 0 };
    const r1 = scoreRun({ ...base, filesChanged: 1 }, codeTask);
    const r3 = scoreRun({ ...base, filesChanged: 3 }, codeTask);
    const r5 = scoreRun({ ...base, filesChanged: 5 }, codeTask);
    const r10 = scoreRun({ ...base, filesChanged: 10 }, codeTask);
    assert.equal(r1.components.throughput, 6);
    assert.equal(r3.components.throughput, 18);
    assert.equal(r5.components.throughput, 30);
    assert.equal(r10.components.throughput, 30); // capped
  });

  it("for analysis tasks, scales on transcript length (capped at 30)", () => {
    const task = { id: "a", expectFilesChanged: false };
    const base = { stopReason: "completed", wallClockMs: 60_000, totalPromptTokens: 10_000, totalResponseTokens: 0 };
    const r1 = scoreRun({ ...base, transcript: Array(1).fill({}) }, task);
    const r10 = scoreRun({ ...base, transcript: Array(10).fill({}) }, task);
    const r20 = scoreRun({ ...base, transcript: Array(20).fill({}) }, task);
    assert.equal(r1.components.throughput, 2);
    assert.equal(r10.components.throughput, 20);
    assert.equal(r20.components.throughput, 30); // capped
  });
});

describe("scoreRun — efficiency component (20 pts)", () => {
  const task = { id: "x", expectFilesChanged: false };
  const base = {
    stopReason: "completed",
    filesChanged: 0,
    transcript: [],
  };

  it("awards full 20 for low token-per-minute rate (<50k)", () => {
    const r = scoreRun(
      { ...base, wallClockMs: 60_000, totalPromptTokens: 30_000, totalResponseTokens: 5_000 },
      task,
    );
    // 35k tokens in 1 min = 35k tok/min < 50k → full 20
    assert.equal(r.components.efficiency, 20);
  });

  it("awards 5 for very high token-per-minute rate (>200k)", () => {
    const r = scoreRun(
      { ...base, wallClockMs: 60_000, totalPromptTokens: 250_000, totalResponseTokens: 0 },
      task,
    );
    assert.equal(r.components.efficiency, 5);
  });

  it("scales linearly between 50k and 200k tok/min", () => {
    // 125k tok/min = midpoint → ~12-13 pts
    const r = scoreRun(
      { ...base, wallClockMs: 60_000, totalPromptTokens: 125_000, totalResponseTokens: 0 },
      task,
    );
    assert.ok(r.components.efficiency >= 11 && r.components.efficiency <= 14, `expected 11–14, got ${r.components.efficiency}`);
  });
});

describe("scoreRun — total + notes string", () => {
  it("composes total from all four components", () => {
    const r = scoreRun(
      {
        stopReason: "completed",
        wallClockMs: 60_000,
        totalPromptTokens: 30_000,
        totalResponseTokens: 0,
        filesChanged: 5,
      },
      { id: "x", expectFilesChanged: true },
    );
    // 40 (completion) + 30 (throughput) + 20 (efficiency) + 5 (conformance) = 95
    assert.equal(r.total, 95);
  });

  it("notes string carries human-readable summary", () => {
    const r = scoreRun(
      {
        stopReason: "completed",
        wallClockMs: 120_000,
        totalPromptTokens: 50_000,
        totalResponseTokens: 0,
        filesChanged: 3,
      },
      { id: "x", expectFilesChanged: true },
    );
    assert.match(r.notes, /completed/);
    assert.match(r.notes, /commits=3/);
    assert.match(r.notes, /\d+s/);
    assert.match(r.notes, /tok\/min/);
  });
});
