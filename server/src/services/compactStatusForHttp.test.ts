import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactStatusForHttp,
  STATUS_HTTP_TRANSCRIPT_TAIL,
} from "./compactStatusForHttp.js";
import type { SwarmStatus } from "../types.js";

function makeStatus(n: number, textLen = 100): SwarmStatus {
  return {
    phase: "stopped",
    round: 0,
    agents: [],
    transcript: Array.from({ length: n }, (_, i) => ({
      id: `e${i}`,
      role: "system" as const,
      text: "x".repeat(textLen),
      ts: i,
    })),
  };
}

describe("compactStatusForHttp", () => {
  it("tails long transcripts", () => {
    const raw = makeStatus(STATUS_HTTP_TRANSCRIPT_TAIL + 50);
    const c = compactStatusForHttp(raw);
    assert.equal(c.transcript.length, STATUS_HTTP_TRANSCRIPT_TAIL);
    assert.equal(c.hydrate?.transcriptTruncated, true);
    assert.equal(c.hydrate?.transcriptTotal, STATUS_HTTP_TRANSCRIPT_TAIL + 50);
    assert.equal(c.transcript[0]?.id, `e${50}`);
  });

  it("does not require a pre-cloned transcript array", () => {
    // statusBuilder may pass the live runner array by reference.
    const live = makeStatus(STATUS_HTTP_TRANSCRIPT_TAIL + 10);
    const shared = live.transcript;
    const c = compactStatusForHttp(live);
    assert.equal(shared.length, STATUS_HTTP_TRANSCRIPT_TAIL + 10);
    assert.equal(c.transcript.length, STATUS_HTTP_TRANSCRIPT_TAIL);
    assert.notEqual(c.transcript, shared);
  });

  it("truncates huge entry texts", () => {
    const raw = makeStatus(2, 50_000);
    const c = compactStatusForHttp(raw, { entryTextMax: 1000 });
    assert.ok((c.transcript[0]?.text?.length ?? 0) < 1200);
    assert.match(c.transcript[0]?.text ?? "", /truncated/);
  });

  it("does not mutate original transcript array", () => {
    const raw = makeStatus(5, 200);
    const before = raw.transcript.length;
    compactStatusForHttp(raw, { tail: 2 });
    assert.equal(raw.transcript.length, before);
  });
});
