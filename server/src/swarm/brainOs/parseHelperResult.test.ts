import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHelperResult } from "./parseHelperResult.js";

describe("parseHelperResult", () => {
  it("parses resolved envelope", () => {
    const raw = JSON.stringify({
      status: "resolved",
      summary: "closed todo",
      effects: [{ type: "board_complete", todoId: "t1", reason: "done" }],
    });
    const r = parseHelperResult(raw, 100);
    assert.equal(r.status, "resolved");
    assert.equal(r.effects[0]?.type, "board_complete");
  });

  it("blocks empty output", () => {
    const r = parseHelperResult("just thinking…", 10);
    assert.equal(r.status, "blocked");
  });
});
