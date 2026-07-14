import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeStopForRun,
  executeDrainForRun,
  type StopDrainOrchestrator,
} from "./runStopDrainHandlers.js";
import { PerRunStopDebounce } from "../swarm/control/perRunStopDebounce.js";

function mockOrch(overrides: Partial<StopDrainOrchestrator> = {}): StopDrainOrchestrator {
  return {
    stopRun: async () => true,
    drainRun: async () => ({ ok: true as const, mode: "soft" as const }),
    ...overrides,
  };
}

describe("executeStopForRun", () => {
  it("kills immediately when drainOnStop is false", async () => {
    let stopped = false;
    const r = await executeStopForRun(
      mockOrch({
        stopRun: async () => {
          stopped = true;
          return true;
        },
        drainRun: async () => {
          throw new Error("drain should not run");
        },
      }),
      "run-a",
      { drainOnStop: false, debounce: new PerRunStopDebounce() },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.action, "kill");
    assert.equal(stopped, true);
  });

  it("first click drains when drainOnStop is true; second within window kills", async () => {
    const debounce = new PerRunStopDebounce();
    let drainCalls = 0;
    let stopCalls = 0;
    const orch = mockOrch({
      drainRun: async () => {
        drainCalls += 1;
        return { ok: true, mode: "soft" };
      },
      stopRun: async () => {
        stopCalls += 1;
        return true;
      },
    });

    const first = await executeStopForRun(orch, "run-a", {
      drainOnStop: true,
      debounce,
    });
    assert.equal(first.body.action, "drain");
    assert.equal(first.body.mode, "soft");
    assert.equal(drainCalls, 1);
    assert.equal(stopCalls, 0);

    const second = await executeStopForRun(orch, "run-a", {
      drainOnStop: true,
      debounce,
    });
    assert.equal(second.body.action, "kill");
    assert.equal(stopCalls, 1);
  });

  it("returns 404 when stopRun fails", async () => {
    const r = await executeStopForRun(
      mockOrch({ stopRun: async () => false }),
      "missing",
      { drainOnStop: false, debounce: new PerRunStopDebounce() },
    );
    assert.equal(r.status, 404);
  });
});

describe("executeDrainForRun", () => {
  it("returns soft mode message", async () => {
    const r = await executeDrainForRun(mockOrch(), "run-a");
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "soft");
    assert.match(String(r.body.message), /Soft drain/i);
  });

  it("returns hard-fallback message", async () => {
    const r = await executeDrainForRun(
      mockOrch({
        drainRun: async () => ({ ok: true, mode: "hard-fallback" }),
      }),
      "run-b",
    );
    assert.equal(r.body.mode, "hard-fallback");
    assert.match(String(r.body.message), /hard-stopped/i);
  });

  it("returns 404 when inactive", async () => {
    const r = await executeDrainForRun(
      mockOrch({ drainRun: async () => false }),
      "gone",
    );
    assert.equal(r.status, 404);
  });
});
