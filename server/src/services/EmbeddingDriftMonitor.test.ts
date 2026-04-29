// Tests for #302 EmbeddingDriftMonitor: cosine math, embedText
// shape handling, polling lifecycle including the model-unavailable
// no-op path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EmbeddingDriftMonitor,
  cosineSimilarity,
  embedText,
} from "./EmbeddingDriftMonitor.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";

function entry(text: string): TranscriptEntry {
  return { id: `t-${Math.random().toString(36).slice(2, 8)}`, role: "agent", text, ts: Date.now() };
}

function fakeEmbedFetch(vector: number[]): typeof fetch {
  return (async () => {
    return {
      ok: true,
      json: async () => ({ embeddings: [vector] }),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3];
    assert.equal(cosineSimilarity(v, [...v]), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("returns -1 for opposite vectors", () => {
    assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
  });

  it("handles vectors with magnitude < 1", () => {
    const r = cosineSimilarity([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]);
    assert.ok(Math.abs(r - 1) < 1e-10);
  });

  it("returns 0 when one vector is all-zero (no division by zero crash)", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  });

  it("throws on dimension mismatch", () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /dim mismatch/);
  });

  it("throws on empty vectors", () => {
    assert.throws(() => cosineSimilarity([], []), /empty/);
  });
});

describe("embedText", () => {
  it("parses the newer batch shape { embeddings: [[...]] }", async () => {
    const v = await embedText({
      text: "hello",
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
      fetchImpl: fakeEmbedFetch([0.1, 0.2, 0.3]),
    });
    assert.deepEqual(v, [0.1, 0.2, 0.3]);
  });

  it("parses the older single-input shape { embedding: [...] }", async () => {
    const stub = (async () => ({
      ok: true,
      json: async () => ({ embedding: [0.4, 0.5] }),
    } as unknown as Response)) as typeof fetch;
    const v = await embedText({
      text: "hello", baseUrl: "u", model: "m", fetchImpl: stub,
    });
    assert.deepEqual(v, [0.4, 0.5]);
  });

  it("strips /v1 from base URL when forming the embed endpoint", async () => {
    let captured = "";
    const stub = (async (url: string) => {
      captured = url;
      return { ok: true, json: async () => ({ embeddings: [[1, 2]] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await embedText({ text: "x", baseUrl: "http://localhost:11533/v1", model: "m", fetchImpl: stub });
    assert.equal(captured, "http://localhost:11533/api/embed");
  });

  it("throws on HTTP non-200", async () => {
    const stub = (async () => ({ ok: false, status: 404 } as Response)) as typeof fetch;
    await assert.rejects(
      embedText({ text: "x", baseUrl: "u", model: "missing", fetchImpl: stub }),
      /HTTP 404/,
    );
  });

  it("throws on missing embedding field", async () => {
    const stub = (async () => ({
      ok: true, json: async () => ({}),
    } as unknown as Response)) as typeof fetch;
    await assert.rejects(
      embedText({ text: "x", baseUrl: "u", model: "m", fetchImpl: stub }),
      /no embedding/,
    );
  });
});

describe("EmbeddingDriftMonitor — lifecycle", () => {
  it("enters no-op mode when initial embed fails (model not pulled)", async () => {
    const events: SwarmEvent[] = [];
    const m = new EmbeddingDriftMonitor({
      runId: "r1",
      directive: "Audit the codebase",
      ollamaBaseUrl: "u",
      getTranscript: () => [entry("text")],
      emit: (e) => events.push(e),
      fetchImpl: (async () => ({ ok: false, status: 404 } as Response)) as typeof fetch,
    });
    await m.start();
    await m.pollOnce();
    assert.equal(events.length, 0);
  });

  it("emits drift_sample on a successful poll", async () => {
    const events: SwarmEvent[] = [];
    // Same vector for directive + transcript → similarity should be ~100
    const m = new EmbeddingDriftMonitor({
      runId: "r1",
      directive: "Audit",
      ollamaBaseUrl: "u",
      getTranscript: () => [entry("Audit the codebase")],
      emit: (e) => events.push(e),
      fetchImpl: fakeEmbedFetch([0.5, 0.5, 0.5]),
    });
    await m.start();
    await m.pollOnce();
    assert.equal(events.length, 1);
    const ev = events[0];
    if (ev.type !== "drift_sample") throw new Error("type narrow");
    // (1 + 1) / 2 * 100 = 100
    assert.equal(ev.similarity, 100);
    assert.equal(ev.smoothedSimilarity, 100);
    assert.equal(ev.embeddingModel, "nomic-embed-text");
  });

  it("smooths across the last 3 raw similarities", async () => {
    const events: SwarmEvent[] = [];
    let returnVec = [1, 0, 0];
    const m = new EmbeddingDriftMonitor({
      runId: "r1",
      directive: "x",
      ollamaBaseUrl: "u",
      getTranscript: () => [entry("text")],
      emit: (e) => events.push(e),
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ embeddings: [returnVec] }),
      } as unknown as Response)) as typeof fetch,
    });
    await m.start();
    // After start, directiveVec is [1, 0, 0]. Each poll embeds the
    // transcript and gets returnVec, similarity = cosine(directiveVec, returnVec)
    returnVec = [1, 0, 0]; await m.pollOnce();   // sim = 1.0 → 100
    returnVec = [0, 1, 0]; await m.pollOnce();   // sim = 0.0 → 50
    returnVec = [-1, 0, 0]; await m.pollOnce();  // sim = -1.0 → 0
    const driftEvents = events.filter((e) => e.type === "drift_sample");
    assert.equal(driftEvents.length, 3);
    if (driftEvents[2].type !== "drift_sample") throw new Error();
    // mean(100, 50, 0) = 50
    assert.equal(driftEvents[2].smoothedSimilarity, 50);
  });

  it("self-stops when isActive returns false", async () => {
    const events: SwarmEvent[] = [];
    let active = true;
    const m = new EmbeddingDriftMonitor({
      runId: "r1", directive: "x", ollamaBaseUrl: "u",
      getTranscript: () => [entry("text")],
      emit: (e) => events.push(e),
      isActive: () => active,
      fetchImpl: fakeEmbedFetch([1, 0, 0]),
    });
    await m.start();
    await m.pollOnce();
    assert.equal(events.length, 1);
    active = false;
    await m.pollOnce();
    assert.equal(events.length, 1, "no new event after isActive=false");
  });

  it("skips poll when transcript is empty", async () => {
    const events: SwarmEvent[] = [];
    const m = new EmbeddingDriftMonitor({
      runId: "r1", directive: "x", ollamaBaseUrl: "u",
      getTranscript: () => [],
      emit: (e) => events.push(e),
      fetchImpl: fakeEmbedFetch([1, 0, 0]),
    });
    await m.start();
    await m.pollOnce();
    assert.equal(events.length, 0);
  });

  it("does NOT throw on transcript-embed failure — silently skips", async () => {
    const events: SwarmEvent[] = [];
    let firstCall = true;
    const stub = (async () => {
      if (firstCall) {
        firstCall = false;
        return {
          ok: true,
          json: async () => ({ embeddings: [[1, 0, 0]] }),
        } as unknown as Response;
      }
      throw new Error("network down");
    }) as typeof fetch;
    const m = new EmbeddingDriftMonitor({
      runId: "r1", directive: "x", ollamaBaseUrl: "u",
      getTranscript: () => [entry("text")],
      emit: (e) => events.push(e),
      fetchImpl: stub,
    });
    await m.start();
    await m.pollOnce();
    assert.equal(events.length, 0);
  });
});
