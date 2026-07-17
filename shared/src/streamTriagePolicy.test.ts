import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicSalvageBrief,
  triageStreamEvidence,
  triageToHandlerAction,
} from "./streamTriagePolicy.js";

describe("streamTriagePolicy", () => {
  it("hard loop without salvage → fail", () => {
    const t = triageStreamEvidence({
      partialText: "<think>x</think>",
      thinkChars: 50_000,
      repetition: { repeats: 6, rLen: 80 },
    });
    assert.equal(t.action, "fail");
    assert.equal(t.verdict.verdict, "loop");
  });

  it("long think → force_emit", () => {
    const partial = `<think>${"plan ".repeat(30_000)}</think>`;
    const t = triageStreamEvidence({
      partialText: partial,
      thinkChars: 100_000,
    });
    assert.equal(t.action, "force_emit");
    assert.equal(t.verdict.verdict, "ready_to_emit");
  });

  it("pure think → class_repair", () => {
    const raw = "<think>We need to implement the FAO route carefully…";
    const t = triageStreamEvidence({
      partialText: raw,
      formatExpect: "json",
      thinkChars: 200,
    });
    assert.equal(t.action, "class_repair");
    assert.match(t.reason, /pure_think/);
  });

  it("short partial → one_continuation", () => {
    const t = triageStreamEvidence({
      partialText: "<think>still exploring the routes and panels carefully now</think>",
      thinkChars: 40_000,
    });
    assert.equal(t.action, "one_continuation");
    const h = triageToHandlerAction(t, t.salvageBrief ? "x".repeat(100) : "<think>still exploring the routes and panels carefully now</think>", false);
    // Use full partial for handler
    const h2 = triageToHandlerAction(
      t,
      "<think>still exploring the routes and panels carefully now</think>",
      false,
    );
    assert.equal(h2.type, "continuation_prompt");
    void h;
  });

  it("second continuation falls through to return_partial", () => {
    const t = triageStreamEvidence({
      partialText: "<think>still exploring the routes and panels carefully now</think>",
      thinkChars: 40_000,
    });
    const h = triageToHandlerAction(
      t,
      "<think>still exploring the routes and panels carefully now</think>",
      true,
    );
    assert.equal(h.type, "return_partial");
  });

  it("buildDeterministicSalvageBrief clips think tail", () => {
    const brief = buildDeterministicSalvageBrief(
      `<think>${"finding ".repeat(500)}</think>\n{"todos":[]}`,
    );
    assert.ok(brief);
    assert.ok(brief!.length > 40);
  });

  it("recovery attempt 2 with partial → force_emit", () => {
    const t = triageStreamEvidence({
      partialText: "<think>I found the panel layout and the API routes structure</think>",
      recoveryAttempt: 3,
      lastFailReason: "parse: missing todos",
      thinkChars: 5_000,
    });
    assert.equal(t.action, "force_emit");
  });
});
