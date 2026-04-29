// Tests for the #295 ConformanceMonitor: verify polling cadence,
// smoothing math, transcript-excerpt budgeting, and the
// failure-modes-don't-throw contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConformanceMonitor,
  buildExcerpt,
  gradeWithOllama,
} from "./ConformanceMonitor.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";

function makeEntry(text: string, ts = Date.now()): TranscriptEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    role: "agent",
    text,
    ts,
  };
}

interface Recorder {
  events: SwarmEvent[];
}
function makeRecorder(): Recorder {
  return { events: [] };
}

/** Build a fetch stub that returns a fixed JSON score response. */
function fakeFetch(score: number, reason = "ok"): typeof fetch {
  return (async () => {
    return {
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ score, reason }) },
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("buildExcerpt", () => {
  it("returns empty string for empty entries", () => {
    assert.equal(buildExcerpt([], 1000), "");
  });

  it("returns single entry's text when under budget", () => {
    const out = buildExcerpt([makeEntry("hello")], 1000);
    assert.equal(out, "hello");
  });

  it("walks newest-to-oldest, joins with divider", () => {
    const entries = [makeEntry("first"), makeEntry("second"), makeEntry("third")];
    const out = buildExcerpt(entries, 1000);
    assert.equal(out, "first\n---\nsecond\n---\nthird");
  });

  it("stops accumulating when the char budget is exceeded", () => {
    const big = "x".repeat(500);
    const entries = [makeEntry("oldest"), makeEntry(big), makeEntry(big), makeEntry(big)];
    const out = buildExcerpt(entries, 700);
    // Should have at MOST the 2 newest big entries (1000 chars > 700 budget)
    // and stop before pulling "oldest" in.
    assert.ok(!out.includes("oldest"), `unexpected oldest in: ${out.slice(0, 80)}`);
  });

  it("skips entries with empty / whitespace-only text", () => {
    const entries = [makeEntry("good"), makeEntry("   "), makeEntry("also good")];
    const out = buildExcerpt(entries, 1000);
    assert.equal(out, "good\n---\nalso good");
  });
});

describe("gradeWithOllama", () => {
  it("parses a clean JSON response", async () => {
    const r = await gradeWithOllama({
      directive: "Add tests",
      excerpt: "agent wrote tests",
      baseUrl: "http://localhost:11434",
      model: "tiny",
      fetchImpl: fakeFetch(85, "good progress"),
    });
    assert.equal(r.score, 85);
    assert.equal(r.reason, "good progress");
  });

  it("clamps scores above 100 and below 0", async () => {
    const high = await gradeWithOllama({
      directive: "x", excerpt: "y", baseUrl: "u", model: "m",
      fetchImpl: fakeFetch(150),
    });
    assert.equal(high.score, 100);
    const low = await gradeWithOllama({
      directive: "x", excerpt: "y", baseUrl: "u", model: "m",
      fetchImpl: fakeFetch(-30),
    });
    assert.equal(low.score, 0);
  });

  it("rounds non-integer scores", async () => {
    const r = await gradeWithOllama({
      directive: "x", excerpt: "y", baseUrl: "u", model: "m",
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ message: { content: '{"score":72.6,"reason":"r"}' } }),
      })) as unknown as typeof fetch,
    });
    assert.equal(r.score, 73);
  });

  it("strips /v1 from base URL when forming the chat endpoint", async () => {
    let capturedUrl = "";
    const stub = (async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ message: { content: '{"score":50}' } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await gradeWithOllama({
      directive: "x", excerpt: "y", baseUrl: "http://localhost:11533/v1",
      model: "m", fetchImpl: stub,
    });
    assert.equal(capturedUrl, "http://localhost:11533/api/chat");
  });

  it("throws on HTTP non-200", async () => {
    const stub = (async () => ({ ok: false, status: 500 } as Response)) as typeof fetch;
    await assert.rejects(
      gradeWithOllama({
        directive: "x", excerpt: "y", baseUrl: "u", model: "m",
        fetchImpl: stub,
      }),
      /HTTP 500/,
    );
  });

  it("throws on malformed JSON content", async () => {
    const stub = (async () => ({
      ok: true,
      json: async () => ({ message: { content: "not json at all" } }),
    } as unknown as Response)) as typeof fetch;
    await assert.rejects(
      gradeWithOllama({
        directive: "x", excerpt: "y", baseUrl: "u", model: "m",
        fetchImpl: stub,
      }),
    );
  });

  it("throws on non-numeric score field", async () => {
    const stub = (async () => ({
      ok: true,
      json: async () => ({ message: { content: '{"score":"bogus"}' } }),
    } as unknown as Response)) as typeof fetch;
    await assert.rejects(
      gradeWithOllama({
        directive: "x", excerpt: "y", baseUrl: "u", model: "m",
        fetchImpl: stub,
      }),
      /not numeric/,
    );
  });
});

describe("ConformanceMonitor — polling + emit", () => {
  it("emits a conformance_sample on a successful poll", async () => {
    const rec = makeRecorder();
    const m = new ConformanceMonitor({
      runId: "r1",
      directive: "Audit the codebase",
      ollamaBaseUrl: "http://localhost:11434",
      graderModel: "m",
      getTranscript: () => [makeEntry("Agent did some auditing.")],
      emit: (e) => rec.events.push(e),
      fetchImpl: fakeFetch(80, "on track"),
    });
    await m.pollOnce();
    assert.equal(rec.events.length, 1);
    const ev = rec.events[0];
    if (ev.type !== "conformance_sample") throw new Error("type narrow");
    assert.equal(ev.score, 80);
    assert.equal(ev.smoothedScore, 80);
    assert.equal(ev.reason, "on track");
    assert.equal(ev.runId, "r1");
  });

  it("smooths across the last 3 raw scores", async () => {
    const rec = makeRecorder();
    let scoreToReturn = 100;
    const m = new ConformanceMonitor({
      runId: "r1",
      directive: "x",
      ollamaBaseUrl: "u",
      graderModel: "m",
      getTranscript: () => [makeEntry("text")],
      emit: (e) => rec.events.push(e),
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ score: scoreToReturn }) },
        }),
      } as unknown as Response)) as typeof fetch,
    });
    scoreToReturn = 90; await m.pollOnce();
    scoreToReturn = 60; await m.pollOnce();
    scoreToReturn = 30; await m.pollOnce();
    scoreToReturn = 30; await m.pollOnce();
    const samples = rec.events.filter((e) => e.type === "conformance_sample");
    assert.equal(samples.length, 4);
    if (samples[0].type !== "conformance_sample") throw new Error();
    if (samples[1].type !== "conformance_sample") throw new Error();
    if (samples[2].type !== "conformance_sample") throw new Error();
    if (samples[3].type !== "conformance_sample") throw new Error();
    assert.equal(samples[0].smoothedScore, 90);                  // [90]
    assert.equal(samples[1].smoothedScore, 75);                  // (90+60)/2
    assert.equal(samples[2].smoothedScore, 60);                  // (90+60+30)/3
    assert.equal(samples[3].smoothedScore, 40);                  // (60+30+30)/3
  });

  it("skips poll when transcript is empty (no event emitted)", async () => {
    const rec = makeRecorder();
    const m = new ConformanceMonitor({
      runId: "r1",
      directive: "x",
      ollamaBaseUrl: "u",
      graderModel: "m",
      getTranscript: () => [],
      emit: (e) => rec.events.push(e),
      fetchImpl: fakeFetch(50),
    });
    await m.pollOnce();
    assert.equal(rec.events.length, 0);
  });

  it("does NOT throw on Ollama failure — silently skips", async () => {
    const rec = makeRecorder();
    const m = new ConformanceMonitor({
      runId: "r1",
      directive: "x",
      ollamaBaseUrl: "u",
      graderModel: "m",
      getTranscript: () => [makeEntry("text")],
      emit: (e) => rec.events.push(e),
      fetchImpl: (async () => {
        throw new Error("ollama down");
      }) as typeof fetch,
    });
    // Should not throw
    await m.pollOnce();
    assert.equal(rec.events.length, 0);
  });

  it("stop() prevents subsequent polls from emitting", async () => {
    const rec = makeRecorder();
    const m = new ConformanceMonitor({
      runId: "r1",
      directive: "x",
      ollamaBaseUrl: "u",
      graderModel: "m",
      getTranscript: () => [makeEntry("text")],
      emit: (e) => rec.events.push(e),
      fetchImpl: fakeFetch(50),
    });
    m.stop();
    await m.pollOnce();
    assert.equal(rec.events.length, 0);
  });

  it("stop() is idempotent + safe to call before start", () => {
    const m = new ConformanceMonitor({
      runId: "r1", directive: "x", ollamaBaseUrl: "u", graderModel: "m",
      getTranscript: () => [], emit: () => {},
      fetchImpl: fakeFetch(50),
    });
    m.stop(); m.stop(); m.stop();
    // No throw = pass.
  });

  it("skips when an in-flight poll is already pending (no pile-up)", async () => {
    const rec = makeRecorder();
    let calls = 0;
    let resolveFetch: ((v: Response) => void) | null = null;
    const slowFetch = (async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as typeof fetch;
    const m = new ConformanceMonitor({
      runId: "r1", directive: "x", ollamaBaseUrl: "u", graderModel: "m",
      getTranscript: () => [makeEntry("text")],
      emit: (e) => rec.events.push(e),
      fetchImpl: slowFetch,
    });
    // Fire two polls; second should bail because first is still inflight
    const p1 = m.pollOnce();
    const p2 = m.pollOnce();
    assert.equal(calls, 1, "second poll should not have hit fetch");
    // Resolve the in-flight call so we can clean up
    resolveFetch?.({
      ok: true,
      json: async () => ({ message: { content: '{"score":50}' } }),
    } as unknown as Response);
    await Promise.all([p1, p2]);
    assert.equal(rec.events.length, 1);
  });
});
