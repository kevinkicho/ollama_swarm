import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  councilWorkerFallbackModel,
  summarizeWorkerFailureReason,
} from "./councilWorkerFallback.js";

describe("councilWorkerFallbackModel", () => {
  it("returns next model from per-run failover chain", () => {
    const next = councilWorkerFallbackModel("deepseek-v4-flash:cloud", [
      "deepseek-v4-flash:cloud",
      "glm-5.1:cloud",
    ]);
    assert.equal(next, "glm-5.1:cloud");
  });

  it("returns undefined when chain has only the current model", () => {
    assert.equal(
      councilWorkerFallbackModel("deepseek-v4-flash:cloud", ["deepseek-v4-flash:cloud"]),
      undefined,
    );
  });

  it("returns undefined for empty chain", () => {
    assert.equal(councilWorkerFallbackModel("glm-5.1:cloud", []), undefined);
  });
});

describe("summarizeWorkerFailureReason", () => {
  it("passes through JSON parse reasons", () => {
    assert.equal(
      summarizeWorkerFailureReason("JSON parse failed: Unexpected token"),
      "JSON parse failed: Unexpected token",
    );
  });

  it("passes through format/provider pure-think reasons", () => {
    const r =
      "format/provider: pure <think> response with no JSON envelope (failover candidate)";
    assert.equal(summarizeWorkerFailureReason(r), r);
  });
});
