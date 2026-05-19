import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { describeSdkError } from "./sdkError.js";

describe("describeSdkError", () => {
  it("formats a plain Error message", () => {
    assert.equal(describeSdkError(new Error("something broke")), "something broke");
  });

  it("formats an Error with a single cause", () => {
    const inner = new Error("DNS lookup failed");
    (inner as any).code = "ENOTFOUND";
    const outer = new Error("fetch failed");
    (outer as any).cause = inner;
    assert.equal(describeSdkError(outer), "fetch failed <- DNS lookup failed [ENOTFOUND]");
  });

  it("walks up to 4-level deep cause chains", () => {
    const e4 = new Error("bottom");
    (e4 as any).code = "E4";
    const e3 = new Error("mid2");
    (e3 as any).cause = e4;
    const e2 = new Error("mid1");
    (e2 as any).cause = e3;
    (e2 as any).code = "E2";
    const e1 = new Error("top");
    (e1 as any).cause = e2;
    assert.equal(describeSdkError(e1), "top <- mid1 [E2] <- mid2 <- bottom [E4]");
  });

  it("caps cause chain at depth 4", () => {
    let e: any = new Error("deepest");
    for (let i = 0; i < 10; i++) {
      const outer = new Error(`level-${i}`);
      (outer as any).cause = e;
      e = outer;
    }
    const result = describeSdkError(e);
    const segments = result.split(" <- ");
    assert.ok(segments.length <= 5, "max 5 segments (1 head + 4 causes)");
  });

  it("handles non-Error cause values by stringifying", () => {
    const outer = new Error("failed");
    (outer as any).cause = 42;
    assert.equal(describeSdkError(outer), "failed <- 42");
  });

  it("handles string input", () => {
    assert.equal(describeSdkError("just a string"), "just a string");
  });

  it("handles objects with message and name", () => {
    const o = { name: "TypeError", message: "x is not a function" };
    assert.equal(describeSdkError(o), "TypeError: x is not a function");
  });

  it("handles objects with message but no name", () => {
    const o = { message: "plain object error" };
    assert.equal(describeSdkError(o), "plain object error");
  });

  it("handles objects with neither name nor message", () => {
    const o = { status: 500, code: "E_SERVER" };
    const result = describeSdkError(o);
    assert.ok(result.includes("500"));
    assert.ok(result.includes("E_SERVER"));
  });

  it("handles circular / non-serializable objects gracefully", () => {
    const o: any = { foo: "bar" };
    o.self = o;
    const result = describeSdkError(o);
    assert.ok(typeof result === "string");
  });

  it("handles null gracefully", () => {
    assert.equal(describeSdkError(null), "null");
  });

  it("handles undefined gracefully", () => {
    assert.equal(describeSdkError(undefined), "undefined");
  });

  it("includes code when present on cause Error", () => {
    const inner = new Error("not found");
    const outer = new Error("request failed");
    (outer as any).cause = inner;
    // inner has no code — should render without [code]
    assert.match(describeSdkError(outer), /request failed <- not found$/);
  });

  test("cause chain with alternating code presence — head code is NOT shown", () => {
    const c3 = new Error("c3");
    (c3 as any).code = "C3";
    const c2 = new Error("c2");
    (c2 as any).cause = c3;
    const c1 = new Error("c1");
    (c1 as any).cause = c2;
    (c1 as any).code = "C1";
    // Head error's code is NOT included (only cause errors get code annotations)
    assert.match(describeSdkError(c1), /c1 <- c2 <- c3 \[C3\]/);
  });

  it("handles boolean input", () => {
    assert.equal(describeSdkError(true), "true");
  });

  it("handles number input", () => {
    assert.equal(describeSdkError(0), "0");
  });
});
