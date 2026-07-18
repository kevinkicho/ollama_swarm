import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveToolProfile } from "./toolProfiles.js";

test("resolveToolProfile maps server ProfileName", () => {
  // Git-native: workers get write/edit/git tools (not read-only).
  assert.equal(resolveToolProfile("worker", { webTools: true }), "swarm-builder-research");
  assert.equal(resolveToolProfile("worker", {}), "swarm-write");
  assert.equal(resolveToolProfile("worker-build", { webTools: true }), "swarm-builder-research");
  assert.equal(resolveToolProfile("auditor", {}), "swarm-read");
  // RR-C PR5: planner web gated on webTools / plannerTools.
  assert.equal(resolveToolProfile("planner", {}), "swarm-read");
  assert.equal(resolveToolProfile("planner", { webTools: false }), "swarm-read");
  assert.equal(resolveToolProfile("planner", { webTools: true }), "swarm-planner");
  assert.equal(resolveToolProfile("planner", { plannerTools: true }), "swarm-planner");
});