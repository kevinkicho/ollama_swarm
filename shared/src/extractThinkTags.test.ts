import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractThinkTags } from "./extractThinkTags.js";

describe("extractThinkTags — basic cases", () => {
  it("returns text unchanged when no <think> tags present", () => {
    const r = extractThinkTags("hello world");
    assert.equal(r.thoughts, "");
    assert.equal(r.finalText, "hello world");
  });

  it("handles empty string", () => {
    const r = extractThinkTags("");
    assert.equal(r.thoughts, "");
    assert.equal(r.finalText, "");
  });

  it("extracts a single <think> block + trailing content", () => {
    const r = extractThinkTags("<think>let me consider</think>my answer");
    assert.equal(r.thoughts, "let me consider");
    assert.equal(r.finalText, "my answer");
  });

  it("extracts a <think> block in the MIDDLE of content", () => {
    const r = extractThinkTags("before<think>x</think>after");
    assert.equal(r.thoughts, "x");
    // before + after, with the gap collapsed — exact spacing not
    // critical, just that both parts survive.
    assert.match(r.finalText, /before/);
    assert.match(r.finalText, /after/);
  });

  it("trims whitespace inside <think> blocks", () => {
    const r = extractThinkTags("<think>  spaced  </think>final");
    assert.equal(r.thoughts, "spaced");
  });
});

describe("extractThinkTags — multi-block + unclosed", () => {
  it("joins multiple <think> blocks with a divider", () => {
    const r = extractThinkTags("<think>first</think>middle<think>second</think>end");
    assert.equal(r.thoughts, "first\n\n---\n\nsecond");
    assert.match(r.finalText, /middle/);
    assert.match(r.finalText, /end/);
  });

  it("treats an UNCLOSED <think> at the tail as a thought", () => {
    const r = extractThinkTags("done\n<think>about to crash");
    assert.equal(r.thoughts, "about to crash");
    assert.equal(r.finalText, "done");
  });

  it("handles closed + unclosed mix (unclosed wins for the tail)", () => {
    const r = extractThinkTags(
      "<think>first done</think>visible<think>still going",
    );
    assert.equal(r.thoughts, "first done\n\n---\n\nstill going");
    assert.equal(r.finalText, "visible");
  });

  it("ignores empty <think></think> blocks", () => {
    const r = extractThinkTags("a<think></think>b<think>real</think>c");
    assert.equal(r.thoughts, "real");
    assert.match(r.finalText, /a/);
    assert.match(r.finalText, /b/);
    assert.match(r.finalText, /c/);
  });
});

describe("extractThinkTags — edge cases + safety", () => {
  it("preserves the ORIGINAL text when extraction empties everything", () => {
    // All content was inside think tags → finalText would be ""
    // but we fall back to the original so the bubble renders SOMETHING.
    const original = "<think>everything is a thought</think>";
    const r = extractThinkTags(original);
    assert.equal(r.thoughts, "everything is a thought");
    assert.equal(r.finalText, original);
  });

  it("collapses 3+ consecutive newlines down to 2 in finalText", () => {
    const r = extractThinkTags("para1\n\n\n\n<think>x</think>\n\n\n\npara2");
    assert.match(r.finalText, /para1\n\npara2/);
    assert.doesNotMatch(r.finalText, /\n{3,}/);
  });

  it("handles multiline thought content", () => {
    const r = extractThinkTags(
      "<think>step 1: consider X\nstep 2: consider Y\nstep 3: decide</think>my answer",
    );
    assert.match(r.thoughts, /step 1/);
    assert.match(r.thoughts, /step 3/);
    assert.equal(r.finalText, "my answer");
  });

  it("handles content that LOOKS like a tag but isn't quite (no extraction)", () => {
    // Variants that should NOT trigger extraction:
    //   - <thinking>...</thinking>  (different tag name)
    //   - <think attr="x">...</think> (we expect bare <think> only)
    const r1 = extractThinkTags("<thinking>not me</thinking>visible");
    assert.equal(r1.thoughts, "");
    assert.equal(r1.finalText, "<thinking>not me</thinking>visible");
    const r2 = extractThinkTags("<think>plain</think>real-final");
    assert.equal(r2.thoughts, "plain");
    assert.equal(r2.finalText, "real-final");
  });

  it("handles very long thought content (no truncation in extractor)", () => {
    // Truncation, if any, is a render-side concern. Extractor must
    // not silently drop content.
    const big = "x".repeat(50_000);
    const r = extractThinkTags(`<think>${big}</think>short`);
    assert.equal(r.thoughts.length, 50_000);
    assert.equal(r.finalText, "short");
  });

  it("handles nested-looking tags (treats first </think> as the closer)", () => {
    // Real nested <think> isn't the model's intent; we accept the
    // first close and let the rest render as plain text.
    const r = extractThinkTags("<think>a<think>b</think>c</think>d");
    assert.equal(r.thoughts, "a<think>b");
    assert.match(r.finalText, /c<\/think>d|c.*d/);
  });
});

describe("extractThinkTags — unpaired </think> at head (RCA preset 1, 2026-04-27)", () => {
  // Some models stream a response that starts mid-thought — there's a
  // </think> closer with no matching opening <think>. Pre-fix, the
  // closer leaked into the visible bubble (e.g. the planner's empty
  // todos response was literally "</think>```json[]```" rendered raw).
  it("strips an unpaired </think> at the head and treats prefix as a thought", () => {
    const r = extractThinkTags("about to commit</think>```json\n[]\n```");
    assert.equal(r.thoughts, "about to commit");
    assert.match(r.finalText, /```json/);
    assert.doesNotMatch(r.finalText, /<\/think>/);
  });

  it("handles bare </think> at the very start (no thought prefix)", () => {
    const r = extractThinkTags("</think>just the response");
    // Empty prefix → no thought stored; closer still consumed.
    assert.equal(r.thoughts, "");
    assert.equal(r.finalText, "just the response");
  });

  it("does NOT strip </think> when it follows a paired <think>", () => {
    // Paired blocks remain the primary path.
    const r = extractThinkTags("<think>paired</think>response");
    assert.equal(r.thoughts, "paired");
    assert.equal(r.finalText, "response");
  });

  it("handles unpaired closer + later paired block", () => {
    const r = extractThinkTags("first thought</think>middle<think>second</think>end");
    assert.equal(r.thoughts, "first thought\n\n---\n\nsecond");
    assert.match(r.finalText, /middle/);
    assert.match(r.finalText, /end/);
  });
});
