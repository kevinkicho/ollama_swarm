// 2026-05-03 (Phase A): unit tests for the directive helper module.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readDirective,
  buildDirectiveBlock,
  buildInlineDirectiveBlock,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
  prependDirectiveSection,
} from "./directivePromptHelpers.js";

describe("readDirective", () => {
  it("returns hasDirective=false on empty / undefined / whitespace", () => {
    assert.deepEqual(readDirective({}), { directive: "", hasDirective: false });
    assert.deepEqual(readDirective({ userDirective: undefined }), { directive: "", hasDirective: false });
    assert.deepEqual(readDirective({ userDirective: "" }), { directive: "", hasDirective: false });
    assert.deepEqual(readDirective({ userDirective: "   \n\n   " }), { directive: "", hasDirective: false });
  });

  it("trims surrounding whitespace and reports hasDirective=true on real content", () => {
    assert.deepEqual(
      readDirective({ userDirective: "  Refactor auth.  " }),
      { directive: "Refactor auth.", hasDirective: true },
    );
  });
});

describe("buildDirectiveBlock", () => {
  it("returns [] when no directive", () => {
    assert.deepEqual(buildDirectiveBlock(readDirective({}), { framingLines: ["x"] }), []);
  });

  it("renders the standard 4-line block when no framing", () => {
    const ctx = readDirective({ userDirective: "Refactor auth." });
    assert.deepEqual(buildDirectiveBlock(ctx), [
      "=== USER DIRECTIVE ===",
      "Refactor auth.",
      "=== END DIRECTIVE ===",
      "",
    ]);
  });

  it("supports a labelSuffix inside the open delimiter", () => {
    const ctx = readDirective({ userDirective: "x" });
    const lines = buildDirectiveBlock(ctx, {
      labelSuffix: "(the question this OW swarm is answering)",
    });
    assert.equal(lines[0], "=== USER DIRECTIVE (the question this OW swarm is answering) ===");
  });

  it("appends framing lines plus a trailing blank when present", () => {
    const ctx = readDirective({ userDirective: "x" });
    const lines = buildDirectiveBlock(ctx, {
      framingLines: ["framing line 1", "framing line 2"],
    });
    assert.deepEqual(lines, [
      "=== USER DIRECTIVE ===",
      "x",
      "=== END DIRECTIVE ===",
      "",
      "framing line 1",
      "framing line 2",
      "",
    ]);
  });

  it("does NOT add a trailing blank when framingLines is empty", () => {
    const ctx = readDirective({ userDirective: "x" });
    const lines = buildDirectiveBlock(ctx, { framingLines: [] });
    // Last line is the post-delimiter blank, not an extra blank.
    assert.equal(lines[lines.length - 1], "");
    assert.equal(lines.length, 4);
  });

  it("trims whitespace-only labelSuffix to bare delimiter", () => {
    const ctx = readDirective({ userDirective: "x" });
    const lines = buildDirectiveBlock(ctx, { labelSuffix: "   " });
    assert.equal(lines[0], "=== USER DIRECTIVE ===");
  });
});

describe("buildInlineDirectiveBlock", () => {
  it("returns [] when no directive", () => {
    assert.deepEqual(
      buildInlineDirectiveBlock(readDirective({}), { contextLabel: "ignored" }),
      [],
    );
  });

  it("renders the inline `Broader directive (...)` line when set", () => {
    const lines = buildInlineDirectiveBlock(
      readDirective({ userDirective: "Refactor auth." }),
      { contextLabel: "the work this debate informs" },
    );
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      'Broader directive (the work this debate informs): "Refactor auth."',
    );
  });

  it("appends followUpLines + a trailing blank when present", () => {
    const lines = buildInlineDirectiveBlock(
      readDirective({ userDirective: "x" }),
      {
        contextLabel: "the work the implementer's edits should advance",
        followUpLines: ["Verify directive-relevance.", "Flag superficial fixes."],
      },
    );
    assert.deepEqual(lines, [
      `Broader directive (the work the implementer's edits should advance): "x"`,
      "Verify directive-relevance.",
      "Flag superficial fixes.",
      "",
    ]);
  });

  it("does NOT add a trailing blank when followUpLines is omitted/empty", () => {
    const lines = buildInlineDirectiveBlock(
      readDirective({ userDirective: "x" }),
      { contextLabel: "label" },
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[lines.length - 1].endsWith('"x"'), true);
  });
});

describe("pickDeliverableTitle", () => {
  it("returns withDirective when set, withoutDirective otherwise", () => {
    const set = readDirective({ userDirective: "x" });
    const unset = readDirective({});
    const opts = { withDirective: "Council: directive answer", withoutDirective: "Council synthesis" };
    assert.equal(pickDeliverableTitle(set, opts), "Council: directive answer");
    assert.equal(pickDeliverableTitle(unset, opts), "Council synthesis");
  });
});

describe("pickAnswerSectionTitle", () => {
  it("flips section title based on directive presence", () => {
    const opts = { withDirective: "Answer to directive", withoutDirective: "Final synthesis" };
    assert.equal(pickAnswerSectionTitle(readDirective({ userDirective: "x" }), opts), "Answer to directive");
    assert.equal(pickAnswerSectionTitle(readDirective({}), opts), "Final synthesis");
  });
});

describe("pickDeliverableSubtitle", () => {
  it("returns base unchanged when no directive", () => {
    assert.equal(pickDeliverableSubtitle(readDirective({}), "3 drafters across 2/2 rounds"), "3 drafters across 2/2 rounds");
  });

  it("appends truncated directive snippet at default maxLen=80", () => {
    const ctx = readDirective({ userDirective: "Refactor auth." });
    const out = pickDeliverableSubtitle(ctx, "3 drafters across 2/2 rounds");
    assert.equal(out, '3 drafters across 2/2 rounds — directive: "Refactor auth."');
  });

  it("truncates and adds ellipsis when directive exceeds maxLen", () => {
    const long = "x".repeat(120);
    const ctx = readDirective({ userDirective: long });
    const out = pickDeliverableSubtitle(ctx, "base", { maxLen: 10 });
    assert.equal(out, 'base — directive: "xxxxxxxxxx…"');
  });

  it("does NOT add ellipsis when directive equals maxLen exactly", () => {
    const ctx = readDirective({ userDirective: "x".repeat(10) });
    const out = pickDeliverableSubtitle(ctx, "base", { maxLen: 10 });
    assert.equal(out, 'base — directive: "xxxxxxxxxx"');
  });
});

describe("maybeDirectiveSection", () => {
  it("returns null when no directive", () => {
    assert.equal(maybeDirectiveSection(readDirective({})), null);
  });

  it("returns { title: 'Directive', body: <directive> } when set", () => {
    assert.deepEqual(
      maybeDirectiveSection(readDirective({ userDirective: "Refactor auth." })),
      { title: "Directive", body: "Refactor auth." },
    );
  });
});

describe("prependDirectiveSection", () => {
  it("returns a new array with Directive at index 0 when set", () => {
    const base = [{ title: "S1", body: "b1" }, { title: "S2", body: "b2" }];
    const out = prependDirectiveSection(readDirective({ userDirective: "x" }), base);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Directive");
    assert.equal(out[0].body, "x");
    assert.equal(out[1].title, "S1");
  });

  it("returns a fresh copy of base when no directive (does not mutate)", () => {
    const base = [{ title: "S1", body: "b1" }];
    const out = prependDirectiveSection(readDirective({}), base);
    assert.notEqual(out, base);
    assert.deepEqual(out, base);
  });
});
