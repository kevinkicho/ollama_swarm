import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkPromptDrift,
  resolveRegistrySourcePath,
} from "./driftGuard.js";
import { promptRegistry } from "./registry.js";

describe("resolveRegistrySourcePath", () => {
  it("resolves prompts/* under blackboard", () => {
    const p = resolveRegistrySourcePath("prompts/planner.ts");
    assert.ok(p.replace(/\\/g, "/").endsWith("blackboard/prompts/planner.ts"));
    assert.ok(fs.existsSync(p), `expected file at ${p}`);
  });

  it("resolves swarm-root helpers", () => {
    const p = resolveRegistrySourcePath("councilPromptHelpers.ts");
    assert.ok(p.replace(/\\/g, "/").endsWith("swarm/councilPromptHelpers.ts"));
    assert.ok(fs.existsSync(p), `expected file at ${p}`);
  });

  it("rejects path escape via .. segments", () => {
    assert.throws(
      () => resolveRegistrySourcePath("prompts/../../../etc/passwd"),
      /escapes root|invalid/i,
    );
  });
});

describe("checkPromptDrift", () => {
  it("passes all registry assertions against source files", async () => {
    assert.ok(promptRegistry.length >= 10, "registry should cover blackboard + discussion");
    const result = await checkPromptDrift();
    if (!result.ok) {
      const detail = result.failures
        .map((f) => `  ${f.prompt}: ${f.assertion}`)
        .join("\n");
      assert.fail(
        `drift check failed (${result.failedAssertions}/${result.totalAssertions}):\n${detail}`,
      );
    }
    assert.ok(result.totalAssertions > 0);
  });
});
