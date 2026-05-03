// 2026-05-03 (Phase A): unit tests for the unified convergence parser.
// Locks the existing parseCouncilConvergence + parseRoleDiffConvergence
// behavior so the migration can drop those without changing semantics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseConvergenceSignal,
  parseConvergenceSignalLoose,
} from "./convergenceSignal.js";

describe("parseConvergenceSignal (strict)", () => {
  it("returns null on empty input", () => {
    assert.equal(parseConvergenceSignal(""), null);
  });

  it("returns null when no CONVERGENCE: line is present", () => {
    assert.equal(parseConvergenceSignal("Just some prose without the signal."), null);
  });

  it("matches a trailing CONVERGENCE: high line", () => {
    const text = "Here is my synthesis...\n\nCONVERGENCE: high";
    assert.equal(parseConvergenceSignal(text), "high");
  });

  it("matches medium and low", () => {
    assert.equal(parseConvergenceSignal("x\nCONVERGENCE: medium"), "medium");
    assert.equal(parseConvergenceSignal("x\nCONVERGENCE: low"), "low");
  });

  it("is case-insensitive on the literal CONVERGENCE", () => {
    assert.equal(parseConvergenceSignal("x\nconvergence: high"), "high");
    assert.equal(parseConvergenceSignal("x\nConvergence: High"), "high");
  });

  it("tolerates trailing whitespace lines (slice -3 of NON-BLANK)", () => {
    const text = "synthesis\n\n\nCONVERGENCE: high\n\n\n";
    assert.equal(parseConvergenceSignal(text), "high");
  });

  it("looks at LAST 3 non-blank lines only — passing 'convergence' word mid-prose is ignored", () => {
    // "convergence" appears in line 1 but not as a CONVERGENCE: line in the tail
    const text = [
      "I think the convergence here is debatable.",
      "Line 2 of synthesis.",
      "Line 3 of synthesis.",
      "Line 4 of synthesis.",
      "Line 5 — final line, but no CONVERGENCE: signal.",
    ].join("\n");
    assert.equal(parseConvergenceSignal(text), null);
  });

  it("matches when CONVERGENCE: is within the last 3 non-blank lines", () => {
    const text = [
      "Long synthesis...",
      "More content...",
      "Even more...",
      "Penultimate line here.",
      "CONVERGENCE: medium",
    ].join("\n");
    assert.equal(parseConvergenceSignal(text), "medium");
  });

  it("does NOT match when CONVERGENCE: is older than the last 3 non-blank lines", () => {
    const text = [
      "CONVERGENCE: high", // line 1 — too far back
      "Then more prose.",
      "More.",
      "And more.",
      "Final line, no signal.",
    ].join("\n");
    assert.equal(parseConvergenceSignal(text), null);
  });

  it("requires `:` before the level (rejects bare 'CONVERGENCE high')", () => {
    assert.equal(parseConvergenceSignal("x\nCONVERGENCE high"), null);
  });

  it("rejects unknown levels", () => {
    assert.equal(parseConvergenceSignal("x\nCONVERGENCE: maybe"), null);
  });
});

describe("parseConvergenceSignalLoose", () => {
  it("returns null on empty / no-match input", () => {
    assert.equal(parseConvergenceSignalLoose(""), null);
    assert.equal(parseConvergenceSignalLoose("just prose"), null);
  });

  it("matches anywhere in text (not just trailing)", () => {
    const text = "Mid-prose: CONVERGENCE: high — and continuation.";
    assert.equal(parseConvergenceSignalLoose(text), "high");
  });

  it("is case-insensitive", () => {
    assert.equal(parseConvergenceSignalLoose("convergence: low"), "low");
  });

  it("prioritizes high > medium > low when multiple appear", () => {
    // Replicates the original RoundRobin inline behavior: high check first
    const text = "convergence: low ... convergence: high ... convergence: medium";
    assert.equal(parseConvergenceSignalLoose(text), "high");
  });

  it("falls through high → medium → low priority", () => {
    assert.equal(parseConvergenceSignalLoose("convergence: medium"), "medium");
    assert.equal(parseConvergenceSignalLoose("convergence: low"), "low");
  });
});

// Migration safety: lock that the strict parser produces the same
// output as the legacy inline implementations would have on these
// representative payloads. If any of these break, the old call sites
// will see different behavior — fix the helper, not the test.
describe("parseConvergenceSignal — legacy compatibility", () => {
  const cases: Array<{ input: string; expected: "high" | "medium" | "low" | null }> = [
    { input: "synthesis prose\nCONVERGENCE: high", expected: "high" },
    { input: "synthesis prose\nCONVERGENCE: medium", expected: "medium" },
    { input: "synthesis prose\nCONVERGENCE: low", expected: "low" },
    { input: "synthesis prose\n\nCONVERGENCE:high\n", expected: "high" }, // tight whitespace
    { input: "no signal at all", expected: null },
    { input: "", expected: null },
  ];
  for (const { input, expected } of cases) {
    it(`returns ${JSON.stringify(expected)} for ${JSON.stringify(input.slice(0, 40))}`, () => {
      assert.equal(parseConvergenceSignal(input), expected);
    });
  }
});
