// 2026-05-02 (blackboard feature #2): PR-shaped output composer tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPRTitle,
  buildPRSummary,
  buildPRDescription,
  type PRCommitEntry,
  type PRCriterionEntry,
} from "./prDescription.js";

describe("buildPRTitle", () => {
  it("returns the directive directly when ≤ 70 chars", () => {
    assert.equal(buildPRTitle("Add input validation"), "Add input validation");
  });

  it("truncates with ellipsis when > 70 chars", () => {
    const long = "Add input validation everywhere across the entire codebase including tests";
    const title = buildPRTitle(long);
    assert.ok(title.length <= 70);
    assert.match(title, /\.\.\.$/);
  });

  it("strips trailing punctuation", () => {
    assert.equal(buildPRTitle("Refactor the auth flow."), "Refactor the auth flow");
    assert.equal(buildPRTitle("What does X do?"), "What does X do");
  });

  it("uses placeholder for empty directive", () => {
    assert.equal(buildPRTitle(""), "Swarm-generated changes");
    assert.equal(buildPRTitle("   "), "Swarm-generated changes");
  });

  it("takes only the first sentence", () => {
    const t = buildPRTitle("Add validation. This will improve security. Also: ship soon.");
    assert.equal(t, "Add validation");
  });
});

describe("buildPRSummary", () => {
  it("includes the directive verbatim + commit count", () => {
    const s = buildPRSummary("Fix the auth bug", [
      { shaPrefix: "abc12345", message: "fix", filesChanged: 1 },
    ]);
    assert.match(s, /"Fix the auth bug"/);
    assert.match(s, /1 commit\b/);
  });

  it("uses plural commits when multiple", () => {
    const s = buildPRSummary("x", [
      { shaPrefix: "a", message: "x", filesChanged: 1 },
      { shaPrefix: "b", message: "y", filesChanged: 2 },
    ]);
    assert.match(s, /2 commits/);
  });

  it("falls back gracefully on empty directive", () => {
    const s = buildPRSummary("", [{ shaPrefix: "a", message: "x", filesChanged: 1 }]);
    assert.match(s, /from a swarm run/);
  });
});

describe("buildPRDescription", () => {
  const sampleCommits: PRCommitEntry[] = [
    { shaPrefix: "abc12345", message: "Add validation to login", filesChanged: 2 },
    { shaPrefix: "def67890", message: "Test edge cases", filesChanged: 1 },
  ];

  const sampleCriteria: PRCriterionEntry[] = [
    { id: "c1", description: "login validates input", verdict: "verified" },
    { id: "c2", description: "tests cover empty inputs", verdict: "partial", rationale: "missing whitespace test" },
    { id: "c3", description: "rate limiting added", verdict: "false", rationale: "not implemented" },
  ];

  it("includes Title + Summary + Changes + Verification + Open sections", () => {
    const md = buildPRDescription({
      directive: "Add input validation to the auth flow",
      commits: sampleCommits,
      verifyPassed: true,
      criteria: sampleCriteria,
    });
    assert.match(md, /^# Add input validation to the auth flow/);
    assert.match(md, /## Summary/);
    assert.match(md, /## Changes/);
    assert.match(md, /## Verification/);
    assert.match(md, /## Open/);
  });

  it("renders verify gate status with the right icon", () => {
    const passed = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: true,
      criteria: [],
    });
    assert.match(passed, /✅ \*\*Verify gate\*\*: PASSED/);
    const failed = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: false,
      criteria: [],
    });
    assert.match(failed, /❌ \*\*Verify gate\*\*: FAILED/);
    const noConfig = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: null,
      criteria: [],
    });
    assert.match(noConfig, /⚪ \*\*Verify gate\*\*: not configured/);
  });

  it("renders per-criterion verdicts with correct icons", () => {
    const md = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: null,
      criteria: sampleCriteria,
    });
    assert.match(md, /✅ verified/);
    assert.match(md, /🟡 partial/);
    assert.match(md, /❌ false/);
  });

  it("lists unmet criteria in the Open section with rationale", () => {
    const md = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: null,
      criteria: sampleCriteria,
    });
    assert.match(md, /\*\*Unmet criteria\*\*/);
    assert.match(md, /not implemented/);
  });

  it("includes stretch goals when provided", () => {
    const md = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: null,
      criteria: [],
      stretchGoals: ["Add documentation site", "Profile cold-start latency"],
    });
    assert.match(md, /\*\*Stretch goals\*\*/);
    assert.match(md, /Add documentation site/);
    assert.match(md, /Profile cold-start latency/);
  });

  it("renders 'no unmet criteria' placeholder when contract fully met", () => {
    const md = buildPRDescription({
      directive: "x",
      commits: [],
      verifyPassed: true,
      criteria: [{ id: "c1", description: "x", verdict: "verified" }],
    });
    assert.match(md, /met its full contract/i);
  });

  it("escapes pipe characters in commit messages (prevents table breakage)", () => {
    const md = buildPRDescription({
      directive: "x",
      commits: [{ shaPrefix: "a", message: "a | b | c", filesChanged: 1 }],
      verifyPassed: null,
      criteria: [],
    });
    assert.match(md, /a \\\| b \\\| c/);
  });
});
