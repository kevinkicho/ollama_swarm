import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryParseBuildResult } from "./BuildResultBubble.js";

describe("tryParseBuildResult", () => {
  it("parses failed command envelope (120b2044 shape)", () => {
    const raw = JSON.stringify({
      ok: false,
      exitCode: 1,
      summary: "Command failed: unknown command 'test)'",
    });
    const r = tryParseBuildResult(raw);
    assert.ok(r);
    assert.equal(r!.ok, false);
    assert.equal(r!.exitCode, 1);
    assert.match(r!.summary, /unknown command/);
  });

  it("ignores hunk envelopes", () => {
    assert.equal(
      tryParseBuildResult(JSON.stringify({ ok: true, hunks: [] })),
      null,
    );
  });
});
