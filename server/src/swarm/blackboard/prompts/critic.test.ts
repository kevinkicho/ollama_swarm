import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCriticRepairPrompt,
  buildCriticUserPrompt,
  CRITIC_FILE_SNIPPET_MAX,
  CRITIC_RECENT_COMMITS_MAX,
  CRITIC_SYSTEM_PROMPT,
  CONSISTENCY_CRITIC_NAME,
  CONSISTENCY_CRITIC_SYSTEM_PROMPT,
  REGRESSION_CRITIC_NAME,
  REGRESSION_CRITIC_SYSTEM_PROMPT,
  SUBSTANCE_CRITIC_NAME,
  parseCriticResponse,
  type CriticSeed,
} from "./critic.js";

function seed(overrides: Partial<CriticSeed> = {}): CriticSeed {
  return {
    proposingAgentId: "agent-2",
    todoDescription: "Add README Quick Start section",
    todoExpectedFiles: ["README.md"],
    files: [
      {
        file: "README.md",
        before: "# proj\n",
        after: "# proj\n\n## Quick Start\nRun: `npm install && npm start`\n",
      },
    ],
    recentCommits: [],
    ...overrides,
  };
}

describe("parseCriticResponse — happy path", () => {
  it("parses a bare object", () => {
    const res = parseCriticResponse(
      JSON.stringify({ verdict: "accept", rationale: "adds a concrete Quick Start section" }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.critic.verdict, "accept");
      assert.match(res.critic.rationale, /Quick Start/);
    }
  });

  it("parses a reject verdict", () => {
    const res = parseCriticResponse(
      JSON.stringify({
        verdict: "reject",
        rationale: "pattern 1 duplicate content: foo.test.ts and bar.test.ts share body",
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.critic.verdict, "reject");
      assert.match(res.critic.rationale, /pattern 1/);
    }
  });

  it("unwraps a fenced ```json block", () => {
    const raw = "```json\n" +
      JSON.stringify({ verdict: "accept", rationale: "ok" }) +
      "\n```";
    const res = parseCriticResponse(raw);
    assert.equal(res.ok, true);
  });

  it("unwraps prose-then-object", () => {
    const raw =
      "Here is my verdict:\n" +
      JSON.stringify({ verdict: "reject", rationale: "pattern 3 rename-only change" }) +
      "\nThat's my call.";
    const res = parseCriticResponse(raw);
    assert.equal(res.ok, true);
  });
});

describe("parseCriticResponse — rejections", () => {
  it("rejects an unknown verdict string", () => {
    const res = parseCriticResponse(
      JSON.stringify({ verdict: "maybe", rationale: "hmm" }),
    );
    assert.equal(res.ok, false);
  });

  it("rejects missing verdict", () => {
    const res = parseCriticResponse(JSON.stringify({ rationale: "hmm" }));
    assert.equal(res.ok, false);
  });

  it("rejects missing rationale", () => {
    const res = parseCriticResponse(JSON.stringify({ verdict: "accept" }));
    assert.equal(res.ok, false);
  });

  it("rejects empty rationale", () => {
    const res = parseCriticResponse(
      JSON.stringify({ verdict: "accept", rationale: "" }),
    );
    assert.equal(res.ok, false);
  });

  it("rejects a bare array", () => {
    const res = parseCriticResponse(
      JSON.stringify([{ verdict: "accept", rationale: "x" }]),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /expected top-level JSON object/);
  });

  it("rejects unparseable JSON", () => {
    const res = parseCriticResponse("not json at all");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /JSON parse failed/);
  });

  it("rejects an over-long rationale (400-char cap)", () => {
    const res = parseCriticResponse(
      JSON.stringify({ verdict: "accept", rationale: "x".repeat(401) }),
    );
    assert.equal(res.ok, false);
  });
});

describe("CRITIC_SYSTEM_PROMPT", () => {
  it("enumerates all six failure patterns", () => {
    for (const pattern of [
      "DUPLICATE CONTENT",
      "TESTS WITHOUT BEHAVIOR",
      "RENAME / REORG",
      "STUB IMPLEMENTATIONS",
      "GENERIC DOCUMENTATION",
      "REGRESSIONS",
    ]) {
      assert.ok(
        CRITIC_SYSTEM_PROMPT.includes(pattern),
        `system prompt should enumerate "${pattern}"`,
      );
    }
  });

  it("explicitly scopes out style / bikeshedding / perfectionism", () => {
    assert.match(CRITIC_SYSTEM_PROMPT, /style/);
    assert.match(CRITIC_SYSTEM_PROMPT, /BETTER approach/);
  });

  it("requires the rationale to name the pattern on reject", () => {
    assert.match(CRITIC_SYSTEM_PROMPT, /MUST name which of the six patterns/);
  });

  it("requires the rationale to cite the concrete add on accept", () => {
    assert.match(CRITIC_SYSTEM_PROMPT, /MUST cite the concrete thing/);
  });

  it("forbids prose / fences", () => {
    assert.match(CRITIC_SYSTEM_PROMPT, /No prose, no fences/);
  });
});

describe("buildCriticUserPrompt", () => {
  it("identifies the proposing agent + todo", () => {
    const p = buildCriticUserPrompt(seed());
    assert.match(p, /Proposing agent: agent-2/);
    assert.match(p, /Add README Quick Start section/);
    assert.match(p, /expectedFiles: README\.md/);
  });

  it("shows a CREATED file with no BEFORE block", () => {
    const p = buildCriticUserPrompt(
      seed({
        files: [
          { file: "LICENSE", before: null, after: "MIT License\n\n..." },
        ],
      }),
    );
    assert.match(p, /LICENSE \(CREATED by this diff\)/);
    assert.match(p, /file did not exist before this diff/);
  });

  it("shows a MODIFIED file with both BEFORE and AFTER blocks", () => {
    const p = buildCriticUserPrompt(seed());
    assert.match(p, /README\.md \(MODIFIED by this diff\)/);
    assert.match(p, /=== BEFORE ===/);
    assert.match(p, /=== AFTER ===/);
  });

  it("renders a parent criterion when provided", () => {
    const p = buildCriticUserPrompt(
      seed({ criterionId: "c1", criterionDescription: "README has Quick Start" }),
    );
    assert.match(p, /Parent criterion/);
    assert.match(p, /\[c1\] README has Quick Start/);
  });

  it("omits the criterion block when no criterion linked", () => {
    const p = buildCriticUserPrompt(seed());
    assert.ok(!p.includes("Parent criterion"));
  });

  it("renders '(no prior commits this run)' when none exist", () => {
    const p = buildCriticUserPrompt(seed());
    assert.match(p, /no prior commits this run/);
  });

  it("lists recent prior commits newest-first", () => {
    const p = buildCriticUserPrompt(
      seed({
        recentCommits: [
          { todoId: "t5", description: "add tests for auth", files: ["auth.test.ts"] },
          { todoId: "t4", description: "add docs", files: ["README.md"] },
        ],
      }),
    );
    assert.match(p, /\[t5\] add tests for auth/);
    assert.match(p, /\[t4\] add docs/);
  });

  it("caps recent-commits list at CRITIC_RECENT_COMMITS_MAX", () => {
    const many = Array.from({ length: CRITIC_RECENT_COMMITS_MAX + 5 }, (_, i) => ({
      todoId: `t${i}`,
      description: `commit ${i}`,
      files: [`file${i}.ts`],
    }));
    const p = buildCriticUserPrompt(seed({ recentCommits: many }));
    // First CRITIC_RECENT_COMMITS_MAX must appear.
    assert.ok(p.includes("[t0]"));
    assert.ok(p.includes(`[t${CRITIC_RECENT_COMMITS_MAX - 1}]`));
    // Past the cap must NOT appear.
    assert.ok(!p.includes(`[t${CRITIC_RECENT_COMMITS_MAX + 4}]`));
  });

  it("truncates a long file snippet at CRITIC_FILE_SNIPPET_MAX", () => {
    const big = "x".repeat(CRITIC_FILE_SNIPPET_MAX + 500);
    const p = buildCriticUserPrompt(
      seed({
        files: [{ file: "big.txt", before: "", after: big }],
      }),
    );
    assert.match(p, /500 chars truncated/);
  });

  it("instructs to evaluate ONLY against the six patterns", () => {
    const p = buildCriticUserPrompt(seed());
    assert.match(p, /ONLY against the six patterns/);
  });
});

describe("buildCriticRepairPrompt", () => {
  it("echoes the parser error + prior response + schema reminder", () => {
    const p = buildCriticRepairPrompt("not JSON at all", "JSON parse failed: x");
    assert.match(p, /JSON parse failed: x/);
    assert.match(p, /not JSON at all/);
    assert.match(p, /accept.*reject/);
  });
});

// Unit 60: ensemble critic prompts (regression + consistency).
describe("Unit 60 — critic ensemble prompts", () => {
  it("exposes the three lane names as constants", () => {
    assert.equal(SUBSTANCE_CRITIC_NAME, "substance");
    assert.equal(REGRESSION_CRITIC_NAME, "regression");
    assert.equal(CONSISTENCY_CRITIC_NAME, "consistency");
  });

  it("regression prompt is narrowly scoped to regression risk", () => {
    assert.match(REGRESSION_CRITIC_SYSTEM_PROMPT, /REGRESSION CRITIC/);
    // Anchors the lane name as the primary lens.
    assert.match(REGRESSION_CRITIC_SYSTEM_PROMPT, /BREAK SOMETHING THAT CURRENTLY WORKS/);
    // Calls out the specific patterns.
    assert.match(REGRESSION_CRITIC_SYSTEM_PROMPT, /CALLER BREAKAGE/);
    assert.match(REGRESSION_CRITIC_SYSTEM_PROMPT, /REMOVED INVARIANT/);
    assert.match(REGRESSION_CRITIC_SYSTEM_PROMPT, /TEST DELETION/);
    // Should NOT poach the substance critic's busywork patterns.
    assert.ok(!/BUSYWORK/.test(REGRESSION_CRITIC_SYSTEM_PROMPT));
  });

  it("consistency prompt is narrowly scoped to codebase fit", () => {
    assert.match(CONSISTENCY_CRITIC_SYSTEM_PROMPT, /CONSISTENCY CRITIC/);
    assert.match(CONSISTENCY_CRITIC_SYSTEM_PROMPT, /DOESN'T MATCH the rest of the codebase/);
    assert.match(CONSISTENCY_CRITIC_SYSTEM_PROMPT, /NAMING DRIFT/);
    assert.match(CONSISTENCY_CRITIC_SYSTEM_PROMPT, /DUPLICATE UTILITY/);
    assert.match(CONSISTENCY_CRITIC_SYSTEM_PROMPT, /BYPASSED ABSTRACTION/);
    assert.ok(!/REGRESSION/.test(CONSISTENCY_CRITIC_SYSTEM_PROMPT));
  });

  it("all three lanes use the same JSON envelope shape so one parser fits all", () => {
    for (const prompt of [
      CRITIC_SYSTEM_PROMPT,
      REGRESSION_CRITIC_SYSTEM_PROMPT,
      CONSISTENCY_CRITIC_SYSTEM_PROMPT,
    ]) {
      assert.match(prompt, /verdict.*accept.*reject/);
      assert.match(prompt, /rationale/);
    }
  });

  it("each lane has a distinct system prompt (no copy-paste leakage)", () => {
    const all = new Set([
      CRITIC_SYSTEM_PROMPT,
      REGRESSION_CRITIC_SYSTEM_PROMPT,
      CONSISTENCY_CRITIC_SYSTEM_PROMPT,
    ]);
    assert.equal(all.size, 3, "all three prompts must be distinct strings");
  });
});
