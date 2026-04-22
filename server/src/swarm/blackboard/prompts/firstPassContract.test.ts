import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
} from "./firstPassContract.js";
import type { PlannerSeed } from "./planner.js";

function seed(overrides: Partial<PlannerSeed> = {}): PlannerSeed {
  return {
    repoUrl: "https://github.com/x/y",
    clonePath: "/tmp/y",
    topLevel: ["README.md", "src"],
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
});
