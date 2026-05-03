// 2026-05-02: tests for the LLM-as-judge module added to fix the
// flat-91-95 scoring problem on analysis tasks. Pure function tests
// only — the network call (judgeAnalysisRun) is exercised end-to-end
// in the next sweep, not unit-tested here (Ollama isn't always
// available in the test env).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgePrompt,
  parseJudgeOutput,
  extractFinalSynthesis,
  multiJudgeAnalysisRun,
} from "./qualityJudge.mjs";

describe("buildJudgePrompt", () => {
  it("includes task description, rubric, and agent output verbatim", () => {
    const p = buildJudgePrompt({
      taskDescription: "Audit the README claims",
      rubric: "(a) names specific claims (b) cites files",
      agentOutput: "The README claims X but the code does Y.",
    });
    assert.match(p, /Audit the README claims/);
    assert.match(p, /\(a\) names specific claims/);
    assert.match(p, /The README claims X but the code does Y\./);
  });

  it("requires JSON output with score + rationale fields", () => {
    const p = buildJudgePrompt({
      taskDescription: "x",
      rubric: "y",
      agentOutput: "z",
    });
    assert.match(p, /"score":\s*<integer 0-100>/);
    assert.match(p, /"rationale":/);
  });

  it("frames the bar honestly so 90+ is rare", () => {
    // Open-weights judge models tend to score generously when prompted
    // with "evaluate this response" alone. The honest-bar prompt keeps
    // the distribution useful for ranking presets.
    const p = buildJudgePrompt({ taskDescription: "x", rubric: "y", agentOutput: "z" });
    assert.match(p, /honest/i);
    assert.match(p, /40-70/);
    assert.match(p, /90\+ is rare/);
  });

  it("truncates very long agent outputs to FINAL_SYNTHESIS_MAX_CHARS (3000)", () => {
    const longOutput = "x".repeat(5000);
    const p = buildJudgePrompt({
      taskDescription: "t",
      rubric: "r",
      agentOutput: longOutput,
    });
    // Find the BEGIN/END block and count `x` chars inside it.
    const block = p.match(/--- BEGIN ---\n([\s\S]*?)\n--- END ---/);
    assert.ok(block, "BEGIN/END block must exist");
    const inside = block[1];
    const xCount = (inside.match(/x/g) ?? []).length;
    assert.equal(xCount, 3000, "agent output must be truncated to 3000 chars");
  });
});

describe("parseJudgeOutput", () => {
  it("parses a clean JSON response", () => {
    const r = parseJudgeOutput('{"score":75,"rationale":"solid analysis"}');
    assert.deepEqual(r, { score: 75, rationale: "solid analysis" });
  });

  it("strips ```json fences", () => {
    const r = parseJudgeOutput('```json\n{"score":60,"rationale":"ok"}\n```');
    assert.deepEqual(r, { score: 60, rationale: "ok" });
  });

  it("extracts JSON from surrounding prose", () => {
    const r = parseJudgeOutput('Here is my judgment:\n{"score":50,"rationale":"meh"}\nThanks!');
    assert.deepEqual(r, { score: 50, rationale: "meh" });
  });

  it("rounds non-integer scores to the nearest integer", () => {
    const r = parseJudgeOutput('{"score":72.6,"rationale":"x"}');
    assert.equal(r.score, 73);
  });

  it("returns null on score out of [0,100] range", () => {
    assert.equal(parseJudgeOutput('{"score":150,"rationale":"x"}'), null);
    assert.equal(parseJudgeOutput('{"score":-5,"rationale":"x"}'), null);
  });

  it("returns null on missing score field", () => {
    assert.equal(parseJudgeOutput('{"rationale":"x"}'), null);
  });

  it("returns null on malformed JSON", () => {
    assert.equal(parseJudgeOutput('{score: 50}'), null);
    assert.equal(parseJudgeOutput('not json at all'), null);
  });

  it("returns null on null/empty input", () => {
    assert.equal(parseJudgeOutput(null), null);
    assert.equal(parseJudgeOutput(""), null);
    assert.equal(parseJudgeOutput("   "), null);
  });

  it("truncates very long rationales to 200 chars", () => {
    const longRat = "x".repeat(500);
    const r = parseJudgeOutput(`{"score":50,"rationale":"${longRat}"}`);
    assert.equal(r.rationale.length, 200);
  });

  it("tolerates missing rationale by setting empty string", () => {
    const r = parseJudgeOutput('{"score":50}');
    assert.equal(r.score, 50);
    assert.equal(r.rationale, "");
  });
});

describe("extractFinalSynthesis", () => {
  it("returns the LAST agent-role entry's text", () => {
    const summary = {
      transcript: [
        { role: "system", text: "kicking off..." },
        { role: "agent", text: "first proposal from agent A. ".repeat(3) },
        { role: "agent", text: "synthesis from aggregator. ".repeat(5) },
        { role: "system", text: "MoA finished" },
      ],
    };
    const out = extractFinalSynthesis(summary);
    assert.match(out, /synthesis from aggregator/);
    assert.doesNotMatch(out, /first proposal from agent A/);
  });

  it("falls back to last system entry when no agent entries exist", () => {
    const summary = {
      transcript: [
        { role: "system", text: "kicking off..." },
        { role: "system", text: "long system summary that's very substantive and over 50 chars long for sure." },
      ],
    };
    const out = extractFinalSynthesis(summary);
    assert.match(out, /long system summary/);
  });

  it("skips agent entries shorter than 50 chars (filters cosmetic noise)", () => {
    const summary = {
      transcript: [
        { role: "agent", text: "real synthesis. " + "x".repeat(100) },
        { role: "agent", text: "ok" },  // too short — skipped
      ],
    };
    const out = extractFinalSynthesis(summary);
    assert.match(out, /real synthesis/);
  });

  it("returns empty string when transcript is missing/empty", () => {
    assert.equal(extractFinalSynthesis(null), "");
    assert.equal(extractFinalSynthesis({}), "");
    assert.equal(extractFinalSynthesis({ transcript: [] }), "");
  });
});

describe("multiJudgeAnalysisRun — inter-rater agreement", () => {
  // Stub fetch that returns predictable per-model scores.
  function makeFetchStub(scoresByModel) {
    return async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const score = scoresByModel[body.model];
      if (score === undefined) {
        return { ok: false, status: 500 };
      }
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ score, rationale: `from ${body.model}` }) },
        }),
      };
    };
  }

  const sampleTask = {
    qualityRubric: "(a) names files (b) cites lines",
    directive: "audit something",
    id: "audit",
  };
  const sampleSummary = {
    transcript: [{ role: "agent", text: "agent synthesis here, with enough text to pass the 50-char filter for sure." }],
  };

  it("returns null when no models supplied", async () => {
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: [],
    });
    assert.equal(r, null);
  });

  it("returns null when ALL judges fail", async () => {
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: ["m1", "m2"],
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(r, null);
  });

  it("returns mean score + per-judge breakdown when judges agree", async () => {
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: ["judge-a", "judge-b", "judge-c"],
      fetchImpl: makeFetchStub({ "judge-a": 70, "judge-b": 75, "judge-c": 72 }),
    });
    assert.ok(r);
    assert.equal(r.judgeCount, 3);
    assert.equal(r.meanScore, 72);
    assert.equal(r.spread, 5);
    assert.equal(r.agreement, "high");
    assert.equal(r.perJudge.length, 3);
  });

  it("classifies medium agreement when spread is 11-25", async () => {
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: ["m1", "m2"],
      fetchImpl: makeFetchStub({ m1: 60, m2: 78 }),
    });
    assert.ok(r);
    assert.equal(r.agreement, "medium");
    assert.equal(r.spread, 18);
  });

  it("classifies LOW agreement when spread ≥ 26", async () => {
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: ["m1", "m2"],
      fetchImpl: makeFetchStub({ m1: 30, m2: 80 }),
    });
    assert.ok(r);
    assert.equal(r.agreement, "low");
    assert.equal(r.spread, 50);
  });

  it("survives PARTIAL judge failure — uses available judges", async () => {
    let callCount = 0;
    const fetchImpl = async (_url, opts) => {
      callCount += 1;
      const body = JSON.parse(opts.body);
      if (body.model === "broken-judge") return { ok: false, status: 500 };
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({ score: 70, rationale: "ok" }) },
        }),
      };
    };
    const r = await multiJudgeAnalysisRun({
      task: sampleTask,
      summary: sampleSummary,
      ollamaBaseUrl: "http://localhost:11434",
      models: ["working", "broken-judge", "working2"],
      fetchImpl,
    });
    assert.ok(r);
    assert.equal(r.judgeCount, 2);
    assert.equal(callCount, 3);
  });
});
