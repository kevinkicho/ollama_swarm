import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRunReconfig } from "./runReconfig.js";
import type { RunConfig } from "./SwarmRunner.js";

function cfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    repoUrl: "https://x",
    localPath: "/tmp/x",
    agentCount: 3,
    rounds: 4,
    model: "test",
    preset: "council",
    wallClockCapMs: 30 * 60_000,
    tokenBudget: 1_000_000,
    ...overrides,
  } as RunConfig;
}

describe("applyRunReconfig", () => {
  it("extends rounds", () => {
    const c = cfg({ rounds: 4 });
    const r = applyRunReconfig(c, { extendRounds: 2 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(c.rounds, 6);
    assert.equal(r.changes.rounds?.to, 6);
  });

  it("rejects lowering rounds", () => {
    const c = cfg({ rounds: 4 });
    const r = applyRunReconfig(c, { rounds: 3 });
    assert.equal(r.ok, false);
    assert.equal(c.rounds, 4);
  });

  it("extends wall-clock cap when one exists", () => {
    const c = cfg({ wallClockCapMs: 20 * 60_000 });
    const r = applyRunReconfig(c, { extendWallClockCapMin: 15 }, { startedAt: 0, now: 5 * 60_000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(c.wallClockCapMs, 35 * 60_000);
  });

  it("sets relative wall-clock cap when none exists", () => {
    const startedAt = 1_000_000;
    const now = startedAt + 10 * 60_000;
    const c = cfg({ wallClockCapMs: undefined });
    const r = applyRunReconfig(c, { extendWallClockCapMin: 20 }, { startedAt, now });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // elapsed 10m + 1m floor + 20m extend
    assert.equal(c.wallClockCapMs, 31 * 60_000);
  });

  it("extends token budget", () => {
    const c = cfg({ tokenBudget: 500_000 });
    const r = applyRunReconfig(c, { extendTokenBudget: 250_000 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(c.tokenBudget, 750_000);
  });

  it("rejects conflicting absolute and extend fields", () => {
    const r = applyRunReconfig(cfg(), { rounds: 8, extendRounds: 2 });
    assert.equal(r.ok, false);
  });

  it("rejects extendRounds when rounds=0", () => {
    const r = applyRunReconfig(cfg({ rounds: 0 }), { extendRounds: 2 });
    assert.equal(r.ok, false);
  });

  it("rejects referee-only reconfig (retired)", () => {
    const c = cfg({ thinkGuardRefereeEnabled: false });
    const r = applyRunReconfig(c, {
      thinkGuardRefereeEnabled: true,
      thinkGuardRefereeMaxCallsPerRun: 10,
    });
    assert.equal(r.ok, false);
  });
});
