import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLegacyActiveRunId } from "./legacyRunResolve.js";
import type { Orchestrator } from "../services/Orchestrator.js";

function mockOrch(runs: Array<{ runId: string }>): Orchestrator {
  return {
    listActiveRuns: () =>
      runs.map((r) => ({
        runId: r.runId,
        runConfig: {},
        startedAt: 0,
        isRunning: true,
        createdBy: "test",
      })),
  } as unknown as Orchestrator;
}

describe("resolveLegacyActiveRunId", () => {
  it("returns the sole active run when unambiguous", () => {
    const result = resolveLegacyActiveRunId(mockOrch([{ runId: "abc" }]));
    assert.deepEqual(result, { ok: true, runId: "abc" });
  });

  it("returns 409 when multiple runs and no runId", () => {
    const result = resolveLegacyActiveRunId(
      mockOrch([{ runId: "a" }, { runId: "b" }]),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.deepEqual(result.runIds, ["a", "b"]);
    }
  });

  it("honors an explicit runId when active", () => {
    const result = resolveLegacyActiveRunId(
      mockOrch([{ runId: "a" }, { runId: "b" }]),
      "b",
    );
    assert.deepEqual(result, { ok: true, runId: "b" });
  });
});