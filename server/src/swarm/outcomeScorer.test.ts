import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRubricGrade,
  defaultRubricForPreset,
  buildRubricGradingPrompt,
} from "./rubricGrading.js";
import {
  scoreRun,
  outcomeToMarkdown,
  attachOutcomeToSummary,
  type RunOutcome,
  type RunOutcomeDimension,
} from "./outcomeScorer.js";
import type { RunSummary } from "./blackboard/summary.js";

const universalRubric = defaultRubricForPreset("council");

describe("outcomeScorer", () => {
  describe("scoreRun — unit-level (no LLM call)", () => {
    it("outcomeToMarkdown produces a markdown table with dimension scores", () => {
      const outcome: RunOutcome = {
        runId: "test-run-1",
        preset: "council",
        agentCount: 3,
        rounds: 3,
        wallClockMs: 120000,
        costUsd: 0.05,
        tokenUsage: { prompt: 5000, completion: 2000 },
        score: 0.75,
        verdict: "needs-revision",
        dimensions: [
          { id: "correctness", label: "Correctness", score: 8, note: "Mostly accurate" },
          { id: "completeness", label: "Completeness", score: 6, note: "Missing edge cases" },
          { id: "specificity", label: "Specificity", score: 7, note: "Cited files" },
          { id: "actionability", label: "Actionability", score: 8, note: "Clear steps" },
          { id: "format", label: "Format", score: 7, note: "Well-structured" },
        ],
        ts: Date.now(),
      };

      const md = outcomeToMarkdown(outcome);
      assert.ok(md.includes("NEEDS-REVISION"));
      assert.ok(md.includes("7.5/10"));
      assert.ok(md.includes("Correctness"));
      assert.ok(md.includes("8/10"));
      assert.ok(md.includes("Missing edge cases"));
      assert.ok(md.includes("Agents: 3"));
      assert.ok(md.includes("Rounds: 3"));
      assert.ok(md.includes("$0.0500"));
    });

    it("attachOutcomeToSummary adds outcome to a RunSummary", () => {
      const outcome: RunOutcome = {
        runId: "test-run-2",
        preset: "debate-judge",
        agentCount: 3,
        rounds: 2,
        wallClockMs: 60000,
        costUsd: 0.02,
        tokenUsage: { prompt: 3000, completion: 1000 },
        score: 0.85,
        verdict: "ship-quality",
        dimensions: [
          { id: "correctness", label: "Correctness", score: 9, note: "Accurate" },
        ],
        ts: Date.now(),
      };

      const summary: RunSummary = {
        repoUrl: "https://github.com/example/repo",
        localPath: "/tmp/repo",
        preset: "debate-judge",
        model: "test-model",
        startedAt: Date.now() - 60000,
        endedAt: Date.now(),
        wallClockMs: 60000,
        stopReason: "completed",
        filesChanged: 5,
        finalGitStatus: "",
        finalGitStatusTruncated: false,
        agents: [],
      };

      const enriched = attachOutcomeToSummary(summary, outcome);
      assert.ok(enriched.outcome);
      assert.equal(enriched.outcome!.score, 0.85);
      assert.equal(enriched.outcome!.verdict, "ship-quality");
      assert.equal(enriched.outcome!.dimensions.length, 1);
    });
  });

  describe("defaultRubricForPreset", () => {
    it("returns universal rubric for discussion presets", () => {
      const rr = defaultRubricForPreset("round-robin");
      assert.equal(rr.length, 5);
      assert.equal(rr[0].id, "correctness");
    });

    it("returns verify-pass for blackboard", () => {
      const bb = defaultRubricForPreset("blackboard");
      assert.equal(bb.length, 6);
      assert.equal(bb[5].id, "verify-pass");
    });

    it("returns evidence-density for debate-judge", () => {
      const dj = defaultRubricForPreset("debate-judge");
      assert.equal(dj.length, 6);
      assert.equal(dj[5].id, "evidence-density");
    });
  });

  describe("parseRubricGrade — integration with outcome scoring", () => {
    it("parses a valid rubric grade", () => {
      const response = JSON.stringify({
        scores: { correctness: 8, completeness: 7, specificity: 6, actionability: 8, format: 7 },
        notes: { correctness: "Accurate", completeness: "Covers most", specificity: "Some citations", actionability: "Clear steps", format: "Good structure" },
        verdict: "ship-quality",
      });

      const grade = parseRubricGrade(response, universalRubric);
      assert.ok(grade);
      assert.equal(grade!.verdict, "ship-quality");
      assert.equal(grade!.scores.correctness, 8);
      assert.equal(grade!.overall, 7.2);
    });

    it("returns null for empty input", () => {
      assert.equal(parseRubricGrade("", universalRubric), null);
    });

    it("returns null for missing verdict", () => {
      const response = JSON.stringify({
        scores: { correctness: 8 },
        notes: { correctness: "Good" },
      });
      assert.equal(parseRubricGrade(response, universalRubric), null);
    });

    it("clamps scores to 0-10", () => {
      const response = JSON.stringify({
        scores: { correctness: 15, completeness: 7, specificity: 6, actionability: 8, format: 7 },
        notes: { correctness: "Accurate", completeness: "Covers most", specificity: "Some citations", actionability: "Clear steps", format: "Good structure" },
        verdict: "ship-quality",
      });
      const grade = parseRubricGrade(response, universalRubric);
      assert.ok(grade);
      assert.equal(grade!.scores.correctness, 10);
    });

    it("parses from fenced code block", () => {
      const response = "```json\n" + JSON.stringify({
        scores: { correctness: 8, completeness: 7, specificity: 6, actionability: 8, format: 7 },
        notes: { correctness: "Accurate", completeness: "Covers most", specificity: "Some citations", actionability: "Clear steps", format: "Good structure" },
        verdict: "needs-revision",
      }) + "\n```";
      const grade = parseRubricGrade(response, universalRubric);
      assert.ok(grade);
      assert.equal(grade!.verdict, "needs-revision");
    });
  });
});