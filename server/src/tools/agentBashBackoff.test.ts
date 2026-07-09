import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASH_ERROR_BACKOFF_THRESHOLD,
  getAgentBashErrors,
  recordAgentBashResult,
  resetAllAgentBashBackoff,
} from "./agentBashBackoff.js";

test("agentBashBackoff — accumulates per agent and resets on success", () => {
  resetAllAgentBashBackoff();
  assert.equal(getAgentBashErrors("agent-2"), 0);
  assert.equal(recordAgentBashResult("agent-2", false), 1);
  assert.equal(recordAgentBashResult("agent-2", false), 2);
  assert.equal(recordAgentBashResult("agent-2", true), 0);
  assert.equal(getAgentBashErrors("agent-2"), 0);
  for (let i = 0; i < BASH_ERROR_BACKOFF_THRESHOLD; i++) {
    recordAgentBashResult("agent-2", false);
  }
  assert.equal(getAgentBashErrors("agent-2"), BASH_ERROR_BACKOFF_THRESHOLD);
  resetAllAgentBashBackoff();
});