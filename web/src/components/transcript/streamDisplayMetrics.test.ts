import { test } from "node:test";
import assert from "node:assert/strict";
import { streamLiveSubtitle, streamWaitingSubtitle } from "./streamDisplayMetrics.js";

test("streamWaitingSubtitle — short wait shows elapsed only", () => {
  const sub = streamWaitingSubtitle(9000, { label: "contract draft" });
  assert.equal(sub, "contract draft · 9s…");
});

test("streamWaitingSubtitle — 60s+ warns no bytes yet", () => {
  const sub = streamWaitingSubtitle(86_000, { label: "contract draft" });
  assert.equal(sub, "contract draft · 86s · no bytes yet…");
});

test("streamWaitingSubtitle — 120s+ waits for first token (not provider stall)", () => {
  const sub = streamWaitingSubtitle(130_000, { label: "contract draft" });
  assert.equal(sub, "contract draft · 130s · waiting for first token…");
});

test("streamLiveSubtitle — reasoning-only includes wall-clock elapsed", () => {
  const sub = streamLiveSubtitle(
    { finalText: "", thoughts: "x".repeat(64457), toolCalls: [], outputChars: 0, thinkingChars: 64457, rawChars: 70000 },
    500,
    false,
    47_000,
  );
  assert.equal(sub, "reasoning · 64,457 chars · 47s…");
});

test("streamLiveSubtitle — writing includes char count and elapsed", () => {
  const sub = streamLiveSubtitle(
    { finalText: "hello", thoughts: "", toolCalls: [], outputChars: 5, thinkingChars: 0, rawChars: 5 },
    500,
    false,
    12_000,
  );
  assert.equal(sub, "writing · 5 chars · 12s…");
});

test("streamLiveSubtitle — paused includes accumulated output chars", () => {
  const sub = streamLiveSubtitle(
    { finalText: "x".repeat(1200), thoughts: "", toolCalls: [], outputChars: 1200, thinkingChars: 0, rawChars: 1200 },
    5000,
    false,
    18_000,
  );
  assert.equal(sub, "paused 5s · 1,200 chars · 18s…");
});