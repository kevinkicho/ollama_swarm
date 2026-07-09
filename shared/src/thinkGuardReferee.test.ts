import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildThinkGuardRefereePrompt,
  clipThinkTail,
  parseThinkGuardVerdict,
} from "./thinkGuardReferee.js";

describe("clipThinkTail", () => {
  it("clips think tail to max chars", () => {
    const partial = `<think>${"x".repeat(20_000)}</think>`;
    const tail = clipThinkTail(partial, 5_000);
    assert.equal(tail.length, 5_000);
  });

  it("returns empty when no think tags", () => {
    assert.equal(clipThinkTail('{"ok":true}', 1000), "");
  });
});

describe("buildThinkGuardRefereePrompt", () => {
  it("includes task metrics and tail", () => {
    const prompt = buildThinkGuardRefereePrompt({
      taskLabel: "contract draft",
      thinkChars: 120_000,
      thinkElapsedMs: 90_000,
      partialText: `<think>${"reason ".repeat(200)}</think>`,
      repetitionHint: "suffix repeat",
    });
    assert.match(prompt, /contract draft/);
    assert.match(prompt, /120,000/);
    assert.match(prompt, /suffix repeat/);
  });
});

describe("parseThinkGuardVerdict", () => {
  it("parses fenced JSON verdict", () => {
    const raw = `\`\`\`json
{"verdict":"loop","confidence":"high","rationale":"repeated tail","suggestedAction":"abort"}
\`\`\``;
    const v = parseThinkGuardVerdict(raw);
    assert.ok(v);
    assert.equal(v!.verdict, "loop");
    assert.equal(v!.suggestedAction, "abort");
  });

  it("returns null for invalid verdict", () => {
    assert.equal(parseThinkGuardVerdict('{"verdict":"unknown","confidence":"high","rationale":"x"}'), null);
  });
});