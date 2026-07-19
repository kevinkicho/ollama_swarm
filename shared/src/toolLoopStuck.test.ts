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

  it("trips on consecutive research failures even with different queries", () => {
    const d = createToolLoopStuckDetector({ maxResearchFailures: 3 });
    assert.equal(d.record("web_search", false, { query: "a" }), null);
    assert.equal(d.record("web_search", false, { query: "b" }), null);
    assert.match(
      d.record("web_fetch", false, { url: "https://example.com" }) ?? "",
      /research tool failures/,
    );
  });

  it("resets research fail streak after a successful fetch", () => {
    const d = createToolLoopStuckDetector({ maxResearchFailures: 3 });
    d.record("web_search", false, { query: "a" });
    d.record("web_search", false, { query: "b" });
    d.record("web_fetch", true, { url: "https://stats.bis.org" });
    assert.equal(d.record("web_search", false, { query: "c" }), null);
  });

  it("allows more identical write iterations than research tools", () => {
    const d = createToolLoopStuckDetector();
    // 3 identical greps still trip at default
    const g = { pattern: "foo", path: "src" };
    d.record("grep", true, g);
    d.record("grep", true, g);
    assert.match(d.record("grep", true, g) ?? "", /repeated grep/);

    const d2 = createToolLoopStuckDetector();
    const w = { path: "a.ts", content: "export const x = 1;\n" };
    for (let i = 0; i < 7; i++) {
      assert.equal(d2.record("write", true, w), null, `write iter ${i} should pass`);
    }
    assert.match(d2.record("write", true, w) ?? "", /repeated write/);
  });

  it("does not trip write when content fingerprint changes", () => {
    const d = createToolLoopStuckDetector({ maxBuilderSameCallRepeats: 3 });
    assert.equal(d.record("write", true, { path: "a.ts", content: "v1" }), null);
    assert.equal(d.record("write", true, { path: "a.ts", content: "v2" }), null);
    assert.equal(d.record("write", true, { path: "a.ts", content: "v3" }), null);
  });
});