import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorkerSkip,
  isGarbageSkipReason,
  isJustifiedPermanentSkip,
} from "./skipClassify.js";

describe("isGarbageSkipReason", () => {
  it("flags placeholders seen live (reason / none)", () => {
    assert.equal(isGarbageSkipReason("reason"), true);
    assert.equal(isGarbageSkipReason("none"), true);
    assert.equal(isGarbageSkipReason("  "), true);
    assert.equal(isGarbageSkipReason("n/a"), true);
  });

  it("allows real short rationales", () => {
    assert.equal(isGarbageSkipReason("already fixed in prior cycle"), false);
    assert.equal(isGarbageSkipReason("file already has the handler"), false);
  });
});

describe("classifyWorkerSkip", () => {
  it("rejects garbage", () => {
    const c = classifyWorkerSkip("reason");
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.reason, "garbage_skip");
  });

  it("maps already-done language to permanent", () => {
    const c = classifyWorkerSkip(
      "already fixed duplicate fx key and dangling string in prior cycle",
    );
    assert.equal(c.ok, true);
    if (c.ok) {
      assert.equal(c.code, "already_done");
      assert.equal(c.permanent, true);
    }
  });

  it("accepts structured permanent:code", () => {
    const c = classifyWorkerSkip("permanent:out-of-scope: not in expectedFiles");
    assert.equal(c.ok, true);
    if (c.ok) {
      assert.equal(c.code, "out_of_scope");
      assert.equal(c.permanent, true);
    }
  });

  it("blocked context is soft (requeue-friendly)", () => {
    const c = classifyWorkerSkip(
      "The TODO asks to fix audit failures but context only has one module",
    );
    assert.equal(c.ok, true);
    if (c.ok) {
      assert.equal(c.code, "blocked");
      assert.equal(c.permanent, false);
    }
  });
});

describe("isJustifiedPermanentSkip", () => {
  it("honors settlement permanent: prefix", () => {
    assert.equal(isJustifiedPermanentSkip("permanent:attempts-exhausted: 2"), true);
  });
});
