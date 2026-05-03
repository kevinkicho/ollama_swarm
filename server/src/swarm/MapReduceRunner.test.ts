import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sliceRoundRobin,
  buildMapperPrompt,
  buildReducerPrompt,
} from "./MapReduceRunner.js";
import type { TranscriptEntry } from "../types.js";

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});

const agent = (index: number, text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "agent",
  agentIndex: index,
  agentId: `agent-${index}`,
  text,
  ts: 0,
});

describe("sliceRoundRobin", () => {
  it("distributes entries evenly when count is a multiple of k", () => {
    const result = sliceRoundRobin(["a", "b", "c", "d"], 2);
    assert.deepEqual(result, [["a", "c"], ["b", "d"]]);
  });

  it("handles uneven distribution (slices differ in length by at most 1)", () => {
    const result = sliceRoundRobin(["a", "b", "c", "d", "e"], 3);
    assert.deepEqual(result, [["a", "d"], ["b", "e"], ["c"]]);
    const lengths = result.map((s) => s.length);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
  });

  it("every entry appears in exactly one slice (partition invariant)", () => {
    const entries = ["src/", "tests/", "docs/", "package.json", "README.md", "LICENSE"];
    const slices = sliceRoundRobin(entries, 3);
    const flat = slices.flat();
    assert.equal(flat.length, entries.length);
    for (const e of entries) assert.ok(flat.includes(e));
  });

  it("handles more slices than entries — extra slices are empty", () => {
    const result = sliceRoundRobin(["a", "b"], 5);
    assert.deepEqual(result, [["a"], ["b"], [], [], []]);
  });

  it("returns empty array when k <= 0", () => {
    assert.deepEqual(sliceRoundRobin(["a", "b"], 0), []);
  });

  it("handles an empty input", () => {
    const result = sliceRoundRobin<string>([], 3);
    assert.deepEqual(result, [[], [], []]);
  });
});

describe("buildMapperPrompt — isolation", () => {
  it("names only the assigned slice in the prompt (no peer slice leakage)", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/", "package.json"], [system("seed")]);
    assert.ok(prompt.includes("src/"));
    assert.ok(prompt.includes("package.json"));
    // Other repo areas that a peer mapper would cover must not appear.
    assert.ok(!prompt.includes("tests/"));
    assert.ok(!prompt.includes("docs/"));
  });

  it("warns the mapper not to speculate about entries outside its slice", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/"], [system("seed")]);
    assert.match(prompt, /Do NOT speculate about entries outside your slice/i);
  });

  it("identifies the mapper by index in header + closing", () => {
    const prompt = buildMapperPrompt(4, 1, 1, ["x"], []);
    assert.ok(prompt.includes("Mapper Agent 4"));
    assert.ok(prompt.includes("Now respond as Mapper Agent 4."));
  });

  it("tells mapper it cannot see peers — by design", () => {
    const prompt = buildMapperPrompt(2, 1, 2, ["x"], []);
    assert.match(prompt, /cannot see.*deliberate/i);
  });

  it("handles an empty slice gracefully", () => {
    const prompt = buildMapperPrompt(5, 1, 1, [], [system("seed")]);
    assert.ok(prompt.includes("(empty slice)"));
  });
});

describe("buildReducerPrompt", () => {
  it("includes mapper reports in the transcript body labeled [Mapper N]", () => {
    const t: TranscriptEntry[] = [
      system("seed"),
      agent(2, "UNIQUE_MAPPER_2_CONTENT"),
      agent(3, "UNIQUE_MAPPER_3_CONTENT"),
    ];
    const prompt = buildReducerPrompt(1, 1, t);
    assert.ok(prompt.includes("UNIQUE_MAPPER_2_CONTENT"));
    assert.ok(prompt.includes("UNIQUE_MAPPER_3_CONTENT"));
    assert.ok(prompt.includes("[Mapper 2]"));
    assert.ok(prompt.includes("[Mapper 3]"));
  });

  it("mid-run cycle asks for a coverage gap to investigate (no directive)", () => {
    const prompt = buildReducerPrompt(1, 3, []);
    assert.match(prompt, /GAP in coverage/i);
  });

  it("last cycle asks for the final unified picture (no directive)", () => {
    const prompt = buildReducerPrompt(3, 3, []);
    assert.match(prompt, /final unified picture/i);
  });

  it("forbids inventing evidence beyond mapper reports", () => {
    const prompt = buildReducerPrompt(1, 1, []);
    assert.match(prompt, /Do NOT invent evidence beyond what mappers reported/i);
  });
});

// 2026-05-02 (map-reduce improvement #1): directive-aware prompt paths.

describe("buildMapperPrompt — directive injection (improvement #1)", () => {
  it("injects USER DIRECTIVE block when directive is set", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/"], [system("seed")], "Find all uses of bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Find all uses of bcrypt\./);
  });

  it("includes the 'no relevant findings is a valid answer' valve", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/"], [], "audit auth");
    assert.match(prompt, /NO RELEVANT FINDINGS.*VALID ANSWER/);
    assert.match(prompt, /Do NOT invent relevance/);
  });

  it("swaps the 'what each entry is' report instructions for directive-relevant ones", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/"], [], "audit auth");
    assert.match(prompt, /which file, what's relevant to the directive, what to do about it/);
    // Old generic copy should NOT be present in the directive path
    assert.ok(
      !/What each entry in your slice is \(purpose \/ role\)\./.test(prompt),
      "directive path must not include the generic 'What each entry is' bullet",
    );
  });

  it("falls back to original generic instructions when directive is absent or whitespace", () => {
    const noDirective = buildMapperPrompt(2, 1, 1, ["src/"], []);
    assert.match(noDirective, /What each entry in your slice is/);
    assert.ok(!/USER DIRECTIVE/.test(noDirective));
    const whitespace = buildMapperPrompt(2, 1, 1, ["src/"], [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(whitespace), "whitespace-only directive must not inject");
  });

  it("preserves the COMPLETE: true|false convergence signal in both paths", () => {
    const withDirective = buildMapperPrompt(2, 1, 1, ["src/"], [], "x");
    const withoutDirective = buildMapperPrompt(2, 1, 1, ["src/"], []);
    for (const p of [withDirective, withoutDirective]) {
      assert.match(p, /COMPLETE: true/);
      assert.match(p, /COMPLETE: false/);
    }
  });
});

describe("buildReducerPrompt — directive injection (improvement #1)", () => {
  it("when directive is set, swaps 'Project picture' for 'Answer to directive' framing", () => {
    const prompt = buildReducerPrompt(1, 1, [], "Find all uses of bcrypt.");
    assert.match(prompt, /USER DIRECTIVE/);
    assert.match(prompt, /Find all uses of bcrypt\./);
    assert.match(prompt, /\*\*Answer to directive\*\*/);
    // The no-directive 'Project picture' headline must NOT leak in
    assert.ok(!/\*\*Project picture\*\*/.test(prompt));
  });

  it("mid-cycle directive path asks for a coverage gap toward the directive", () => {
    const prompt = buildReducerPrompt(1, 3, [], "x");
    assert.match(prompt, /Coverage gap toward the directive/);
  });

  it("final-cycle directive path asks for final answer + next step", () => {
    const prompt = buildReducerPrompt(3, 3, [], "x");
    assert.match(prompt, /Final answer to the directive/);
    assert.match(prompt, /single most important next step/);
  });

  it("acknowledges the slice-gap concept (off-topic mappers reporting no findings)", () => {
    const prompt = buildReducerPrompt(1, 1, [], "x");
    assert.match(prompt, /SLICE GAPS/);
    assert.match(prompt, /no findings relevant/);
  });

  it("falls back to original Project-picture framing when directive absent", () => {
    const prompt = buildReducerPrompt(1, 1, []);
    assert.match(prompt, /\*\*Project picture\*\*/);
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.ok(!/\*\*Answer to directive\*\*/.test(prompt));
  });

  it("treats whitespace-only directive as absent", () => {
    const prompt = buildReducerPrompt(1, 1, [], "   \n\n   ");
    assert.ok(!/USER DIRECTIVE/.test(prompt));
    assert.match(prompt, /\*\*Project picture\*\*/);
  });
});

// Structural: confirm form spec flips and runner threading.

import { readFileSync as _read } from "node:fs";
import { join as _join, dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";

const _here = _dirname(_fileURLToPath(import.meta.url));
const MR_SRC = _read(_join(_here, "MapReduceRunner.ts"), "utf8");

describe("MapReduceRunner — directive plumbing (structural, post Phase A)", () => {
  it("(#1 + Phase A) seed uses readDirective + buildDirectiveBlock helpers", () => {
    assert.match(MR_SRC, /readDirective\(cfg\)/);
    assert.match(MR_SRC, /buildDirectiveBlock\(/);
  });

  it("(#1) runMapperTurn forwards cfg.userDirective into buildMapperPrompt", () => {
    assert.match(
      MR_SRC,
      /this\.runMapperTurn\([\s\S]{0,200}cfg\.userDirective\)/,
      "loop must thread cfg.userDirective into runMapperTurn",
    );
    assert.match(
      MR_SRC,
      /buildMapperPrompt\(agent\.index, round, totalRounds, slice, visibleSeed, userDirective\)/,
      "runMapperTurn must thread userDirective into buildMapperPrompt",
    );
  });

  it("(#1) runReducerTurn forwards cfg.userDirective into buildReducerPrompt", () => {
    assert.match(
      MR_SRC,
      /this\.runReducerTurn\([\s\S]{0,200}cfg\.userDirective\)/,
      "loop must thread cfg.userDirective into runReducerTurn",
    );
    assert.match(
      MR_SRC,
      /buildReducerPrompt\(round, totalRounds, \[\.\.\.this\.transcript\], userDirective\)/,
      "runReducerTurn must thread userDirective into buildReducerPrompt",
    );
  });

  it("(#2 + Phase A) deliverable uses pickDeliverableTitle + maybeDirectiveSection helpers", () => {
    assert.match(
      MR_SRC,
      /pickDeliverableTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Map-reduce: directive answer"/,
      "deliverable title must use pickDeliverableTitle helper",
    );
    assert.match(
      MR_SRC,
      /pickAnswerSectionTitle\(dirCtx,\s*\{[\s\S]{0,200}?withDirective:\s*"Answer to directive"/,
      "synthesis section title must use pickAnswerSectionTitle helper",
    );
    assert.match(MR_SRC, /maybeDirectiveSection\(dirCtx\)/);
  });
});

describe("Map-reduce form spec", () => {
  it("(#1) marks map-reduce as directive: 'honored' in SetupForm.tsx", () => {
    const setup = _read(
      _join(_here, "../../../web/src/components/SetupForm.tsx"),
      "utf8",
    );
    const block = setup.match(/id:\s*"map-reduce"[\s\S]{0,1200}?\},/);
    assert.ok(block, "map-reduce preset block must exist");
    assert.match(block![0], /directive:\s*"honored"/);
  });
});
