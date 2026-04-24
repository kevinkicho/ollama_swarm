import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCouncilContractMergePrompt,
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  buildTierUpPrompt,
  type CouncilContractDraft,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
  type TierUpSeedInput,
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

  // Unit 50: prior-run block for the resume path.
  it("system prompt has a Rule 12 teaching the planner how to handle PRIOR RUN", () => {
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /PRIOR RUN.*Unit 50/);
    assert.match(FIRST_PASS_CONTRACT_SYSTEM_PROMPT, /re-attempt/i);
  });

  it("user prompt OMITS the PRIOR RUN block when priorRunSummary is absent", () => {
    const p = buildFirstPassContractUserPrompt(seed({ priorRunSummary: undefined }));
    assert.ok(!p.includes("PRIOR RUN"), "no prior block on fresh clones");
  });

  it("user prompt INCLUDES the PRIOR RUN block with per-criterion status", () => {
    const p = buildFirstPassContractUserPrompt(
      seed({
        priorRunSummary: {
          startedAtIso: "2026-04-23T18:22:05.380Z",
          missionStatement: "Fill the balance sheet gaps.",
          criteria: [
            {
              id: "c1",
              description: "Populate KLA financial fields",
              status: "met",
              rationale: "All null fields filled at line 608.",
              expectedFiles: ["assets/js/companies-data.js"],
            },
            {
              id: "c2",
              description: "Extend TSMC timeseries to 5 years",
              status: "unmet",
              rationale: "Only 2 years present.",
              expectedFiles: ["assets/js/companies-timeseries.js"],
            },
            {
              id: "c3",
              description: "Verify chart console errors",
              status: "wont-do",
              rationale: "Requires browser devtools — workers can't.",
              expectedFiles: [],
            },
          ],
        },
      }),
    );
    assert.match(p, /=== PRIOR RUN/);
    assert.match(p, /2026-04-23T18:22:05\.380Z/);
    assert.match(p, /Fill the balance sheet gaps/);
    // Each criterion line encodes id + status + description.
    assert.match(p, /\[c1\] \(met\) Populate KLA/);
    assert.match(p, /\[c2\] \(unmet\) Extend TSMC/);
    assert.match(p, /\[c3\] \(wont-do\) Verify chart/);
    // expectedFiles rendered for the criteria that have them.
    assert.match(p, /files: assets\/js\/companies-data\.js/);
    // Closing line changes to point at Rule 12.
    assert.match(p, /build on the PRIOR RUN above \(Rule 12\)/);
  });

  it("user prompt truncates long prior rationales with an ellipsis", () => {
    const longRationale = "x".repeat(2_000);
    const p = buildFirstPassContractUserPrompt(
      seed({
        priorRunSummary: {
          startedAtIso: "2026-04-23T00:00:00.000Z",
          missionStatement: "m",
          criteria: [
            {
              id: "c1",
              description: "d",
              status: "met",
              rationale: longRationale,
              expectedFiles: [],
            },
          ],
        },
      }),
    );
    // Raw 2000-char rationale must not appear verbatim.
    assert.ok(!p.includes(longRationale));
    assert.match(p, /\.\.\./);
  });

  it("PRIOR RUN block appears AFTER USER DIRECTIVE but BEFORE repo state", () => {
    const p = buildFirstPassContractUserPrompt(
      seed({
        userDirective: "ship docs",
        priorRunSummary: {
          startedAtIso: "2026-04-23T00:00:00.000Z",
          missionStatement: "m",
          criteria: [{ id: "c1", description: "d", status: "unmet", expectedFiles: [] }],
        },
      }),
    );
    const directiveIdx = p.indexOf("=== USER DIRECTIVE");
    const priorIdx = p.indexOf("=== PRIOR RUN");
    const repoIdx = p.indexOf("Repository:");
    assert.ok(directiveIdx >= 0 && priorIdx >= 0 && repoIdx >= 0);
    assert.ok(
      directiveIdx < priorIdx && priorIdx < repoIdx,
      "directive → prior run → repo state ordering",
    );
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

// Unit 34: ambition-ratchet tier-up prompt.
describe("buildTierUpPrompt", () => {
  function tierSeed(overrides: Partial<TierUpSeedInput> = {}): TierUpSeedInput {
    return {
      nextTier: 2,
      maxTiers: 5,
      priorMissionStatement: "Document the public API.",
      priorCriteria: [
        {
          id: "c1",
          description: "README has Quick Start",
          status: "met",
          expectedFiles: ["README.md"],
          rationale: "README contains usage section.",
        },
        {
          id: "c2",
          description: "Add LICENSE",
          status: "met",
          expectedFiles: ["LICENSE"],
        },
      ],
      committedFiles: ["README.md", "LICENSE"],
      repoFiles: ["README.md", "LICENSE", "src/index.ts"],
      readmeExcerpt: "# proj\n\nA library.",
      ...overrides,
    };
  }

  it("frames the next tier with its number and the max tiers", () => {
    const p = buildTierUpPrompt(tierSeed({ nextTier: 3, maxTiers: 7 }));
    assert.match(p, /Tier 2 of this run is complete/);
    assert.match(p, /TIER 3 contract/);
    assert.match(p, /at most 7 tiers/);
  });

  it("shows every prior criterion with its status + description", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /\[c1\] \(met\) README has Quick Start/);
    assert.match(p, /\[c2\] \(met\) Add LICENSE/);
  });

  it("includes prior-tier rationale when present", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /README contains usage section\./);
  });

  it("lists committed files under their own section", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /FILES COMMITTED ACROSS PRIOR TIERS/);
    assert.match(p, /\nREADME\.md\n/);
    assert.match(p, /\nLICENSE\n/);
  });

  it("includes REPO FILE LIST for expectedFiles grounding", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /REPO FILE LIST/);
    assert.match(p, /\nsrc\/index\.ts\n/);
  });

  it("states the ambition-must-rise + anti-busywork rules explicitly", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /Ambition must rise/);
    assert.match(p, /Anti-busywork/);
    assert.match(p, /EXTEND the prior work, not revise or duplicate it/);
  });

  it("caps at 20 criteria and prefers 4-10 per tier", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /Maximum 20 criteria/);
    assert.match(p, /Prefer 4.{1,3}10/);
  });

  it("INCLUDES the USER DIRECTIVE block when a directive is present", () => {
    const p = buildTierUpPrompt(
      tierSeed({ userDirective: "Make this README-driven." }),
    );
    assert.match(p, /USER DIRECTIVE \(AUTHORITATIVE/);
    assert.match(p, /applies at every tier/);
    assert.match(p, /Make this README-driven\./);
    // The directive-specific rule is visible in the tier-specific form.
    assert.match(p, /AUTHORITATIVE at every tier/);
  });

  it("OMITS the USER DIRECTIVE block when directive is absent", () => {
    const p = buildTierUpPrompt(tierSeed({ userDirective: undefined }));
    assert.ok(!p.includes("USER DIRECTIVE"));
    assert.match(p, /No user directive this run/);
  });

  it("OMITS the USER DIRECTIVE block when directive is whitespace-only", () => {
    const p = buildTierUpPrompt(tierSeed({ userDirective: "   " }));
    assert.ok(!p.includes("USER DIRECTIVE"));
  });

  it("falls back gracefully when repoFiles is empty", () => {
    const p = buildTierUpPrompt(tierSeed({ repoFiles: [] }));
    assert.match(p, /REPO FILE LIST/);
    assert.match(p, /no files listed/);
  });

  it("falls back gracefully when readmeExcerpt is null", () => {
    const p = buildTierUpPrompt(tierSeed({ readmeExcerpt: null }));
    assert.match(p, /no README found at repo root/);
  });

  it("falls back gracefully when committedFiles is empty", () => {
    const p = buildTierUpPrompt(tierSeed({ committedFiles: [] }));
    assert.match(p, /no commits yet/);
  });

  it("caps committed-file list at 80 entries so a huge run doesn't blow the prompt", () => {
    const many = Array.from({ length: 120 }, (_, i) => `src/gen/file${i}.ts`);
    const p = buildTierUpPrompt(tierSeed({ committedFiles: many }));
    // First 80 included, past 80 excluded.
    assert.ok(p.includes("src/gen/file0.ts"));
    assert.ok(p.includes("src/gen/file79.ts"));
    assert.ok(!p.includes("src/gen/file100.ts"));
  });

  it("instructs to output ONLY a JSON object with the shared envelope shape", () => {
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /No prose/);
    assert.match(p, /No fences/);
    assert.match(p, /missionStatement.*criteria/);
  });

  it("is parseable by parseFirstPassContractResponse when the model returns a valid envelope", () => {
    // Not a structural test — just a reminder that the tier-up prompt
    // expects the SAME envelope shape as the first-pass contract, so
    // the same parser works end-to-end.
    const p = buildTierUpPrompt(tierSeed());
    assert.match(p, /{"missionStatement": string, "criteria": \[\.\.\.\]}/);
  });
});
