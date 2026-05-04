// T199 (2026-05-04): tests for the LLM-driven dynamic role catalog
// helper. Pure-function coverage for the prompt builder + parser.
// Integration with the live agent is exercised in the runner.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRoleCatalogPrompt,
  parseRoleCatalogResponse,
} from "./dynamicRoleCatalog.js";

describe("buildRoleCatalogPrompt — pure", () => {
  it("includes the directive verbatim", () => {
    const prompt = buildRoleCatalogPrompt({
      agent: { id: "x", index: 1, port: 0, model: "y", sessionId: "s", cwd: "" } as never,
      manager: {} as never,
      directive: "Refactor auth from JWT to sessions",
      topLevel: ["src", "test"],
    });
    assert.match(prompt, /Refactor auth from JWT to sessions/);
  });

  it("renders top-level entries as comma-list", () => {
    const prompt = buildRoleCatalogPrompt({
      agent: {} as never,
      manager: {} as never,
      directive: "anything",
      topLevel: ["src", "tests", "docs"],
    });
    assert.match(prompt, /src, tests, docs/);
  });

  it("falls back when no readme excerpt provided", () => {
    const prompt = buildRoleCatalogPrompt({
      agent: {} as never,
      manager: {} as never,
      directive: "x",
      topLevel: [],
    });
    assert.match(prompt, /no README excerpt available/);
  });

  it("truncates readme excerpt to 2000 chars", () => {
    const long = "a".repeat(5000);
    const prompt = buildRoleCatalogPrompt({
      agent: {} as never,
      manager: {} as never,
      directive: "x",
      topLevel: [],
      readmeExcerpt: long,
    });
    // The "a" run inside === END README === bookends should be ≤ 2000 chars.
    const match = prompt.match(/=== README EXCERPT[\s\S]*?===\n([\s\S]*?)\n===/);
    assert.ok(match, "should contain readme block");
    assert.ok(match![1]!.length <= 2000, `readme not truncated: ${match![1]!.length}`);
  });
});

describe("parseRoleCatalogResponse — pure", () => {
  it("parses well-formed JSON with 4 roles", () => {
    const raw = JSON.stringify({
      roles: [
        { name: "Auth specialist", guidance: "Auth flows", deliverableHint: "Token spec" },
        { name: "Security reviewer", guidance: "Vulns", deliverableHint: "Risks" },
        { name: "Migration planner", guidance: "Steps", deliverableHint: "Plan" },
        { name: "Test analyst", guidance: "Coverage", deliverableHint: "Gaps" },
      ],
    });
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.equal(out!.length, 4);
    assert.equal(out![0]!.name, "Auth specialist");
  });

  it("tolerates fenced JSON", () => {
    const raw = "```json\n" + JSON.stringify({
      roles: [
        { name: "A", guidance: "g" },
        { name: "B", guidance: "g" },
        { name: "C", guidance: "g" },
      ],
    }) + "\n```";
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.equal(out!.length, 3);
  });

  it("dedups duplicate names case-insensitively", () => {
    const raw = JSON.stringify({
      roles: [
        { name: "Auth", guidance: "g" },
        { name: "auth", guidance: "g2" },
        { name: "Security", guidance: "g" },
        { name: "Tester", guidance: "g" },
      ],
    });
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.equal(out!.length, 3);
  });

  it("drops roles with empty guidance", () => {
    const raw = JSON.stringify({
      roles: [
        { name: "A", guidance: "good" },
        { name: "B", guidance: "" },
        { name: "C", guidance: "good" },
        { name: "D", guidance: "good" },
      ],
    });
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.equal(out!.length, 3);
  });

  it("returns null when fewer than 3 valid roles", () => {
    const raw = JSON.stringify({
      roles: [{ name: "A", guidance: "g" }, { name: "B", guidance: "g" }],
    });
    assert.equal(parseRoleCatalogResponse(raw), null);
  });

  it("returns null on non-JSON input", () => {
    assert.equal(parseRoleCatalogResponse("not json at all"), null);
  });

  it("returns null when roles is not an array", () => {
    assert.equal(
      parseRoleCatalogResponse(JSON.stringify({ roles: "oops" })),
      null,
    );
  });

  it("caps at 8 roles even if more provided", () => {
    const roles = Array.from({ length: 12 }, (_, i) => ({
      name: `Role ${i}`,
      guidance: "g",
    }));
    const out = parseRoleCatalogResponse(JSON.stringify({ roles }));
    assert.ok(out);
    assert.equal(out!.length, 8);
  });

  it("truncates over-long guidance to 600 chars", () => {
    const long = "x".repeat(2000);
    const raw = JSON.stringify({
      roles: [
        { name: "A", guidance: long },
        { name: "B", guidance: "g" },
        { name: "C", guidance: "g" },
      ],
    });
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.ok(out![0]!.guidance.length <= 600);
  });

  it("drops roles with name > 60 chars", () => {
    const longName = "x".repeat(70);
    const raw = JSON.stringify({
      roles: [
        { name: longName, guidance: "g" },
        { name: "ok1", guidance: "g" },
        { name: "ok2", guidance: "g" },
        { name: "ok3", guidance: "g" },
      ],
    });
    const out = parseRoleCatalogResponse(raw);
    assert.ok(out);
    assert.equal(out!.length, 3);
    assert.ok(!out!.some((r) => r.name === longName));
  });
});
