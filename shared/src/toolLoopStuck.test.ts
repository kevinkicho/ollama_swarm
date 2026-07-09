import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createToolLoopStuckDetector } from "./toolLoopStuck.js";

describe("createToolLoopStuckDetector", () => {
  it("trips on consecutive errors", () => {
    const d = createToolLoopStuckDetector({ maxConsecutiveErrors: 3 });
    assert.equal(d.record("bash", false, { command: "a" }), null);
    assert.equal(d.record("bash", false, { command: "b" }), null);
    assert.match(d.record("bash", false, { command: "c" }) ?? "", /consecutive tool errors/);
  });

  it("trips on identical repeated calls", () => {
    const d = createToolLoopStuckDetector({ maxSameCallRepeats: 3 });
    const args = { pattern: "foo", path: "src" };
    assert.equal(d.record("grep", true, args), null);
    assert.equal(d.record("grep", false, args), null);
    assert.match(d.record("grep", false, args) ?? "", /repeated grep/);
  });

  it("resets error streak on success", () => {
    const d = createToolLoopStuckDetector({ maxConsecutiveErrors: 3 });
    d.record("bash", false, {});
    d.record("read", true, { path: "x" });
    assert.equal(d.record("bash", false, {}), null);
  });
});