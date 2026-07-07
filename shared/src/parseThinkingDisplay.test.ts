import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseThinkingDisplay, summarizePseudoToolMarker } from "./parseThinkingDisplay.js";

describe("parseThinkingDisplay", () => {
  it("splits prose from DeepSeek function blocks", () => {
    const text = `Let me read key files first.
<function>
<function name>read</function>
<parameter name="path">C:\\repo\\src\\data\\marketPanels.js</parameter>
</function>`;
    const r = parseThinkingDisplay(text);
    assert.match(r.prose, /Let me read key files first/);
    assert.equal(r.intents.length, 1);
    assert.equal(r.intents[0]!.name, "read");
    assert.equal(r.intents[0]!.detail, "data/marketPanels.js");
  });
});

describe("summarizePseudoToolMarker", () => {
  it("labels bare read tags with path", () => {
    const raw = "<read path='src/foo.ts' />";
    const s = summarizePseudoToolMarker(raw);
    assert.equal(s.name, "read");
    assert.equal(s.detail, "src/foo.ts");
  });
});