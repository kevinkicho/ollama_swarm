import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCouncilContractMergePrompt,
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  type CouncilContractDraft,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./firstPassContract.js";
import type { PlannerSeed } from "./planner.js";

function seed(overrides: Partial<PlannerSeed> = {}): PlannerSeed {
  return {
    repoUrl: "https://github.com/x/y",
    clonePath: "/tmp/y",
    topLevel: ["README.md", "src"],
    repoFiles: ["README.md", "src/index.ts"],
    readmeExcerpt: "# y\n\nSomething.",
    ...overrides,
  };
}

describe("parseFirstPassContractResponse — happy path", () => {
  it("parses a bare object", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify({
        missionStatement: "Ship the quick start.",
        criteria: [
          { description: "README has Quick Start", expectedFiles: ["README.md"] },
          { description: "Link to license", expectedFiles: [] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.contract.missionStatement, "Ship the quick start.");
      assert.equal(res.contract.criteria.length, 2);
      assert.deepEqual(res.contract.criteria[0]?.expectedFiles, ["README.md"]);
      assert.deepEqual(res.contract.criteria[1]?.expectedFiles, []);
      assert.equal(res.dropped.length, 0);
    }
  });

  it("unwraps a fenced ```json block", () => {
    const raw = "```json\n" +
      JSON.stringify({
        missionStatement: "Do the thing.",
        criteria: [{ description: "c1", expectedFiles: ["a.ts"] }],
      }) + "\n```";
    const res = parseFirstPassContractResponse(raw);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.contract.criteria.length, 1);
    }
  });

  it("unwraps prose-then-object", () => {
    const raw =
      "Here is the contract for this run:\n" +
      JSON.stringify({
        missionStatement: "Doc pass.",
        criteria: [{ description: "c", expectedFiles: ["README.md"] }],
      }) +
      "\nLet me know!";
    const res = parseFirstPassContractResponse(raw);
    assert.equal(res.ok, true);
  });

  it("accepts empty criteria array (trivial repo, nothing to add)", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify({ missionStatement: "Nothing to do.", criteria: [] }),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.contract.criteria.length, 0);
  });
});

describe("parseFirstPassContractResponse — rejections and drops", () => {
  it("rejects a bare array (planner responded like old schema)", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify([{ description: "x", expectedFiles: ["a"] }]),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /expected top-level JSON object/);
  });

  it("rejects when missionStatement is missing", () => {
    const res = parseFirstPassContractResponse(JSON.stringify({ criteria: [] }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /missionStatement/);
  });

  it("rejects when criteria is not an array", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify({ missionStatement: "m", criteria: "oops" }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /criteria must be an array/);
  });

  it("drops individual invalid criteria but keeps the contract", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify({
        missionStatement: "m",
        criteria: [
          { description: "ok", expectedFiles: ["a"] },
          { description: "", expectedFiles: ["a"] },
          { description: "too many", expectedFiles: ["1", "2", "3", "4", "5"] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.contract.criteria.length, 1);
      assert.equal(res.dropped.length, 2);
    }
  });

  it("rejects unparseable JSON", () => {
    const res = parseFirstPassContractResponse("not json at all");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /JSON parse failed/);
  });

  it("drops criteria whose expectedFiles include a directory path", () => {
    const res = parseFirstPassContractResponse(
      JSON.stringify({
        missionStatement: "m",
        criteria: [
          { description: "good", expectedFiles: ["README.md"] },
          { description: "fwd slash dir", expectedFiles: ["src/"] },
          { description: "backslash dir", expectedFiles: ["lib\\"] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.contract.criteria.length, 1);
      assert.equal(res.dropped.length, 2);
      assert.match(res.dropped[0].reason, /file path, not a directory/);
      assert.match(res.dropped[1].reason, /file path, not a directory/);
    }
  });
});

describe("FIRST_PASS_CONTRACT prompts", () => {
  it("system prompt mentions the required shape keys", () => {
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /missionStatement/);
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /criteria/);
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /expectedFiles/);
  });

  it("user prompt embeds repo URL + README excerpt", () => {
    const p = buildFirstPassContractUserPrompt(seed({ readmeExcerpt: "hello world" }));
    assert.match(p, /github\.com\/x\/y/);
    assert.match(p, /hello world/);
  });

  it("user prompt handles missing README", () => {
    const p = buildFirstPassContractUserPrompt(seed({ readmeExcerpt: null }));
    assert.match(p, /no README found/);
  });

  it("repair prompt echoes the parser error and prior response", () => {
    const p = buildFirstPassContractRepairPrompt("bad output", "JSON parse failed: xyz");
    assert.match(p, /bad output/);
    assert.match(p, /JSON parse failed: xyz/);
    assert.match(p, /missionStatement/);
  });

  // Grounding Unit 6a
  it("user prompt renders REPO FILE LIST with one path per line", () => {
    const p = buildFirstPassContractUserPrompt(
      seed({ repoFiles: ["README.md", "src/a.ts", "src/lib/b.ts"] }),
    );
    assert.match(p, /=== REPO FILE LIST/);
    assert.match(p, /=== end REPO FILE LIST/);
    // Each path on its own line so the model can quote verbatim
    assert.match(p, /\nREADME\.md\n/);
    assert.match(p, /\nsrc\/a\.ts\n/);
    assert.match(p, /\nsrc\/lib\/b\.ts\n/);
  });

  it("user prompt falls back gracefully when repoFiles is empty", () => {
    const p = buildFirstPassContractUserPrompt(seed({ repoFiles: [] }));
    assert.match(p, /no files listed/);
    assert.match(p, /=== REPO FILE LIST/);
  });

  it("system prompt instructs to ground expectedFiles in REPO FILE LIST", () => {
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /REPO FILE LIST/);
  });

  // Unit 25: user-directive field should be authoritative in the
  // contract prompt when present, and transparent when absent.
  it("user prompt OMITS the USER DIRECTIVE block when directive is absent", () => {
    const p = buildFirstPassContractUserPrompt(seed({ userDirective: undefined }));
    assert.ok(!p.includes("USER DIRECTIVE"), "no directive block should appear when none provided");
  });

  it("user prompt OMITS the USER DIRECTIVE block when directive is empty string", () => {
    const p = buildFirstPassContractUserPrompt(seed({ userDirective: "   " }));
    assert.ok(!p.includes("USER DIRECTIVE"), "whitespace-only directive should not produce a block");
  });

  it("user prompt INCLUDES the USER DIRECTIVE block at the top when directive is provided", () => {
    const p = buildFirstPassContractUserPrompt(
      seed({
        userDirective:
          "Make this project deliver every feature its README.md advertises.",
      }),
    );
    assert.match(p, /=== USER DIRECTIVE \(AUTHORITATIVE/);
    assert.match(p, /Make this project deliver every feature/);
    // Directive block must appear BEFORE the repo URL / tree / README excerpt
    // so the planner reads intent first.
    const directiveIdx = p.indexOf("=== USER DIRECTIVE");
    const repoIdx = p.indexOf("Repository:");
    assert.ok(directiveIdx >= 0 && repoIdx >= 0 && directiveIdx < repoIdx,
      "directive block must come before the repo info in the prompt");
  });

  it("user prompt closing line changes to name the directive when present", () => {
    const p = buildFirstPassContractUserPrompt(seed({ userDirective: "ship docs" }));
    assert.match(p, /MUST address the USER DIRECTIVE/);
  });

  it("system prompt has a Rule 11 referencing USER DIRECTIVE authoritatively", () => {
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /USER DIRECTIVE.*AUTHORITATIVE/i);
    // Cap bumped 12 -> 20 to accommodate directive-driven runs.
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /Maximum 20 criteria/);
  });
});

// Unit 30: council-style initial contract merge prompt.
describe("buildCouncilContractMergePrompt", () => {
  function draft(
    agentId: string,
    mission: string,
    criteria: Array<{ description: string; expectedFiles: string[] }>,
  ): CouncilContractDraft {
    return { agentId, contract: { missionStatement: mission, criteria } };
  }

  it("renders every draft's mission statement and criteria list", () => {
    const drafts: CouncilContractDraft[] = [
      draft("agent-1", "Document the API.", [
        { description: "README has Quick Start", expectedFiles: ["README.md"] },
      ]),
      draft("agent-2", "Polish the README.", [
        { description: "Link license in README", expectedFiles: ["README.md", "LICENSE"] },
      ]),
    ];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    // Both missions appear
    assert.match(p, /Document the API\./);
    assert.match(p, /Polish the README\./);
    // Both agents attributed
    assert.match(p, /by agent-1/);
    assert.match(p, /by agent-2/);
    // Criteria descriptions visible
    assert.match(p, /README has Quick Start/);
    assert.match(p, /Link license in README/);
    // Grounding block still present so merge can validate paths
    assert.match(p, /REPO FILE LIST/);
  });

  it("labels drafts with their 1-based index", () => {
    const drafts: CouncilContractDraft[] = [
      draft("agent-1", "m1", []),
      draft("agent-2", "m2", []),
      draft("agent-3", "m3", []),
    ];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    assert.match(p, /Draft 1/);
    assert.match(p, /Draft 2/);
    assert.match(p, /Draft 3/);
  });

  it("mentions the draft count in the framing line", () => {
    const drafts: CouncilContractDraft[] = [
      draft("agent-1", "m", []),
      draft("agent-2", "m", []),
      draft("agent-3", "m", []),
      draft("agent-4", "m", []),
    ];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    // e.g. "4 agents ... each drafted"
    assert.match(p, /4 agents/);
  });

  it("renders an empty expectedFiles list as '(none)' for readability", () => {
    const drafts: CouncilContractDraft[] = [
      draft("agent-1", "m", [{ description: "outcome without files", expectedFiles: [] }]),
    ];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    assert.match(p, /expectedFiles: \(none\)/);
  });

  it("includes merge rules for union/dedupe + grounding + 20-criterion cap", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    assert.match(p, /UNION/);
    assert.match(p, /DEDUPE/);
    assert.match(p, /Maximum 20 criteria/);
    assert.match(p, /REPO FILE LIST/);
  });

  it("INCLUDES USER DIRECTIVE block and directive-specific rule when directive is present", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(
      seed({ userDirective: "Ship every README feature." }),
      drafts,
    );
    assert.match(p, /USER DIRECTIVE \(AUTHORITATIVE/);
    assert.match(p, /Ship every README feature\./);
    // The directive-specific merge rule (authoritative language) shows up
    assert.match(p, /MUST address every distinct outcome the directive names/);
  });

  it("OMITS USER DIRECTIVE block when directive is absent and says so in Rule 7", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed({ userDirective: undefined }), drafts);
    assert.ok(!p.includes("USER DIRECTIVE"), "no directive block when absent");
    // Rule 7's no-directive variant is present instead
    assert.match(p, /No user directive this run/);
  });

  it("OMITS USER DIRECTIVE block when directive is whitespace-only", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed({ userDirective: "   " }), drafts);
    assert.ok(!p.includes("USER DIRECTIVE"), "whitespace directive treated as absent");
  });

  it("falls back gracefully when repoFiles is empty", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed({ repoFiles: [] }), drafts);
    assert.match(p, /REPO FILE LIST/);
    assert.match(p, /clone may be unreadable/);
  });

  it("falls back gracefully when readmeExcerpt is null", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed({ readmeExcerpt: null }), drafts);
    assert.match(p, /no README found/);
  });

  it("instructs to output ONLY a JSON object (no prose, no fences)", () => {
    const drafts: CouncilContractDraft[] = [draft("agent-1", "m", [])];
    const p = buildCouncilContractMergePrompt(seed(), drafts);
    assert.match(p, /No prose/);
    assert.match(p, /no fences/);
  });
});
