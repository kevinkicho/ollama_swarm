import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveToolProfile } from "./toolProfiles.js";

test("resolveToolProfile maps server ProfileName", () => {
  assert.equal(resolveToolProfile("worker", { webTools: true }), "swarm-research");
  assert.equal(resolveToolProfile("worker-build", { webTools: true }), "swarm-builder-research");
  assert.equal(resolveToolProfile("auditor", {}), "swarm-read");
  assert.equal(resolveToolProfile("planner", {}), "swarm-planner");
  assert.equal(resolveToolProfile("planner", { webTools: false }), "swarm-planner");
});