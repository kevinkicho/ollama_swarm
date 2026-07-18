import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatWorkerAttemptOutcomeLine } from "./workerAttemptOutcome.js";

describe("formatWorkerAttemptOutcomeLine", () => {
  it("emits compact single-line operator log", () => {
    const line = formatWorkerAttemptOutcomeLine({
      todoId: "abcdef12-3456",
      agentId: "agent-2",
      stage: "settled",
      terminal: "completed",
      file: "src/a.ts",
      detTried: true,
      detOk: true,
    });
    assert.match(line, /\[worker-outcome\]/);
    assert.match(line, /agent-2/);
    assert.match(line, /completed/);
    assert.match(line, /det=ok/);
  });
});
