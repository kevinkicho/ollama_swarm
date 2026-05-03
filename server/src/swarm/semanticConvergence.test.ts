// 2026-05-02 (issue #4 fix): tests for embedding-based semantic
// convergence. Pure-function tests for jaccardToCosineThreshold;
// network-call tests stub fetch so we exercise the embed-then-cosine
// path without needing Ollama.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectSemanticConvergence,
  jaccardToCosineThreshold,
} from "./semanticConvergence.js";

describe("jaccardToCosineThreshold — pure mapping", () => {
  it("maps 0.4 (debate/decision) → 0.78", () => {
    assert.equal(jaccardToCosineThreshold(0.4), 0.78);
  });
  it("maps 0.5 (exploration) → 0.82", () => {
    assert.equal(jaccardToCosineThreshold(0.5), 0.82);
  });
  it("maps 0.7 (analysis/report) → 0.88", () => {
    assert.equal(jaccardToCosineThreshold(0.7), 0.88);
  });
  it("very-strict thresholds (>0.7) → 0.92", () => {
    assert.equal(jaccardToCosineThreshold(0.85), 0.92);
    assert.equal(jaccardToCosineThreshold(1.0), 0.92);
  });
  it("low thresholds (<0.4) also map to 0.78 (lower bound)", () => {
    assert.equal(jaccardToCosineThreshold(0.2), 0.78);
  });
});

describe("detectSemanticConvergence — embedding-driven", () => {
  // Stub fetch that returns a fixed embedding per text. Used to test
  // the cosine path without needing real Ollama.
  function makeFetchStub(textToVec: Record<string, number[]>) {
    return (async (_url: string | URL | Request, opts?: RequestInit) => {
      const body = JSON.parse(String(opts?.body ?? "{}"));
      const text = body.input as string;
      const vec = textToVec[text];
      if (!vec) {
        return { ok: false, status: 500 } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ embeddings: [vec] }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  it("converged when cosine ≥ threshold", async () => {
    // Identical vectors → cosine = 1
    const fetchImpl = makeFetchStub({
      "the report says X": [1, 0, 0, 0],
      "the report SAYS X": [1, 0, 0, 0],
    });
    const r = await detectSemanticConvergence({
      prior: "the report says X",
      current: "the report SAYS X",
      ollamaBaseUrl: "http://localhost:11434",
      threshold: 0.85,
      fetchImpl,
    });
    assert.ok(r);
    assert.equal(r!.signal, "embedding");
    assert.equal(r!.similarity, 1);
    assert.equal(r!.converged, true);
  });

  it("not converged when cosine < threshold", async () => {
    // Orthogonal vectors → cosine = 0
    const fetchImpl = makeFetchStub({
      "alpha": [1, 0, 0, 0],
      "beta": [0, 1, 0, 0],
    });
    const r = await detectSemanticConvergence({
      prior: "alpha",
      current: "beta",
      ollamaBaseUrl: "http://localhost:11434",
      threshold: 0.85,
      fetchImpl,
    });
    assert.ok(r);
    assert.equal(r!.similarity, 0);
    assert.equal(r!.converged, false);
  });

  it("returns null when embed call fails (caller falls back to Jaccard)", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 } as unknown as Response);
    const r = await detectSemanticConvergence({
      prior: "x",
      current: "y",
      ollamaBaseUrl: "http://localhost:11434",
      fetchImpl,
    });
    assert.equal(r, null);
  });

  it("returns trivially-identical (1.0) for both-empty inputs without calling embed", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ embeddings: [[1]] }) } as unknown as Response;
    };
    const r = await detectSemanticConvergence({
      prior: "",
      current: "   ",
      ollamaBaseUrl: "http://localhost:11434",
      fetchImpl,
    });
    assert.ok(r);
    assert.equal(r!.similarity, 1);
    assert.equal(r!.converged, true);
    assert.equal(calls, 0, "should NOT call embed when both inputs are empty");
  });

  it("returns 0 (not converged) when one side empty + the other non-empty", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ embeddings: [[1]] }) } as unknown as Response;
    };
    const r = await detectSemanticConvergence({
      prior: "",
      current: "something",
      ollamaBaseUrl: "http://localhost:11434",
      fetchImpl,
    });
    assert.ok(r);
    assert.equal(r!.similarity, 0);
    assert.equal(r!.converged, false);
    assert.equal(calls, 0);
  });
});
