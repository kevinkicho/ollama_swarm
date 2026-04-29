// Tests for the #299 AmendmentsBuffer. Cover the lifecycle (open →
// add → list → close), bounding (chars + count), and edge cases
// (closed runId, whitespace-only text, no-op operations).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AmendmentsBuffer } from "./AmendmentsBuffer.js";

describe("AmendmentsBuffer — lifecycle", () => {
  it("isOpen is false before open + true after", () => {
    const b = new AmendmentsBuffer();
    assert.equal(b.isOpen("r1"), false);
    b.open("r1");
    assert.equal(b.isOpen("r1"), true);
  });

  it("close drops the buffer + isOpen returns false", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.add("r1", "first");
    b.close("r1");
    assert.equal(b.isOpen("r1"), false);
    assert.deepEqual(b.list("r1"), []);
  });

  it("open is idempotent — re-open clears the buffer", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.add("r1", "old");
    b.open("r1");
    assert.deepEqual(b.list("r1"), []);
  });

  it("close is idempotent — close before open is a no-op", () => {
    const b = new AmendmentsBuffer();
    assert.doesNotThrow(() => b.close("never-opened"));
  });
});

describe("AmendmentsBuffer — add + list", () => {
  it("stores added amendments in insertion order", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.add("r1", "first");
    b.add("r1", "second");
    b.add("r1", "third");
    const list = b.list("r1");
    assert.equal(list.length, 3);
    assert.equal(list[0].text, "first");
    assert.equal(list[1].text, "second");
    assert.equal(list[2].text, "third");
  });

  it("each amendment carries a ts timestamp", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    const before = Date.now();
    const a = b.add("r1", "x");
    const after = Date.now();
    assert.ok(a);
    assert.ok(a!.ts >= before && a!.ts <= after, `ts out of range: ${a!.ts}`);
  });

  it("returns the stored Amendment from add()", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    const a = b.add("r1", "  hello  ");
    assert.ok(a);
    assert.equal(a!.text, "hello");
  });

  it("returns null when adding to a closed runId", () => {
    const b = new AmendmentsBuffer();
    const a = b.add("never-opened", "text");
    assert.equal(a, null);
  });

  it("returns null when text is empty after trimming", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    assert.equal(b.add("r1", ""), null);
    assert.equal(b.add("r1", "   "), null);
    assert.equal(b.add("r1", "\n\t  \n"), null);
    assert.deepEqual(b.list("r1"), []);
  });

  it("list returns a defensive copy — caller can't mutate buffer state", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.add("r1", "x");
    const list = b.list("r1");
    list.push({ ts: 0, text: "injected" });
    assert.equal(b.list("r1").length, 1);
  });
});

describe("AmendmentsBuffer — bounding", () => {
  it("clamps amendment text to 1000 chars", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    const huge = "x".repeat(5000);
    const a = b.add("r1", huge);
    assert.ok(a);
    assert.equal(a!.text.length, 1000);
  });

  it("caps the per-run buffer at 20 entries (LRU-drops oldest)", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    for (let i = 0; i < 25; i++) b.add("r1", `amendment-${i}`);
    const list = b.list("r1");
    assert.equal(list.length, 20);
    // Oldest (5 first ones) dropped; newest is "amendment-24"
    assert.equal(list[0].text, "amendment-5");
    assert.equal(list[list.length - 1].text, "amendment-24");
  });
});

describe("AmendmentsBuffer — multi-run isolation", () => {
  it("amendments for one run don't leak into another", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.open("r2");
    b.add("r1", "for-r1");
    b.add("r2", "for-r2");
    assert.equal(b.list("r1").length, 1);
    assert.equal(b.list("r2").length, 1);
    assert.equal(b.list("r1")[0].text, "for-r1");
    assert.equal(b.list("r2")[0].text, "for-r2");
  });

  it("closing one run doesn't affect another", () => {
    const b = new AmendmentsBuffer();
    b.open("r1");
    b.open("r2");
    b.add("r1", "x");
    b.add("r2", "y");
    b.close("r1");
    assert.deepEqual(b.list("r1"), []);
    assert.equal(b.list("r2").length, 1);
  });
});
