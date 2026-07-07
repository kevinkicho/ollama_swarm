import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHunkReviewRepairPrompt,
  parseHunkReviewResponse,
} from "./hunkReview.js";

describe("parseHunkReviewResponse", () => {
  it("parses bare JSON", () => {
    const r = parseHunkReviewResponse('{"approve":true,"reason":"ship it"}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.approve, true);
      assert.equal(r.reason, "ship it");
    }
  });

  it("strips think tags before parsing", () => {
    const r = parseHunkReviewResponse(
      '<think>We should approve</think>\n{"approve":false,"reason":"bad anchor"}',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.approve, false);
      assert.equal(r.reason, "bad anchor");
    }
  });

  it("fails when approve is not boolean", () => {
    const r = parseHunkReviewResponse('{"approve":"yes","reason":"x"}');
    assert.equal(r.ok, false);
  });

  it("repair prompt includes parser error and prior response", () => {
    const p = buildHunkReviewRepairPrompt("bad body", "no JSON object found");
    assert.match(p, /no JSON object found/);
    assert.match(p, /bad body/);
  });
});