import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnnotation,
  buildExplorerPrompt,
  formatAnnotations,
  rankingScore,
  PHEROMONE_DECAY_PER_ROUND,
  type AnnotationState,
} from "./stigmergyPromptHelpers.js";

describe("parseAnnotation — happy path", () => {
  it("parses a clean JSON object", () => {
    const raw = '{"file":"src/foo.ts","interest":7,"confidence":5,"note":"load-bearing"}';
    const ann = parseAnnotation(raw);
    assert.ok(ann);
    assert.equal(ann!.file, "src/foo.ts");
    assert.equal(ann!.interest, 7);
    assert.equal(ann!.confidence, 5);
    assert.equal(ann!.note, "load-bearing");
  });

  it("strips a markdown fence and parses", () => {
    const raw = "prose here\n```json\n{\"file\":\"a.md\",\"interest\":3,\"confidence\":8,\"note\":\"\"}\n```";
    const ann = parseAnnotation(raw);
    assert.ok(ann);
    assert.equal(ann!.file, "a.md");
  });

  it("finds the annotation JSON at end of a prose response", () => {
    const raw =
      "I read package.json. It's the workspace root declaring server and web.\n" +
      '{"file":"package.json","interest":4,"confidence":9,"note":"workspace root"}';
    const ann = parseAnnotation(raw);
    assert.ok(ann);
    assert.equal(ann!.file, "package.json");
    assert.equal(ann!.interest, 4);
  });
});

describe("parseAnnotation — clamping and rejection", () => {
  it("clamps interest > 10 back to 10", () => {
    const raw = '{"file":"x","interest":100,"confidence":5,"note":"n"}';
    const ann = parseAnnotation(raw);
    assert.equal(ann!.interest, 10);
  });

  it("clamps negative interest to 0", () => {
    const raw = '{"file":"x","interest":-5,"confidence":5,"note":"n"}';
    const ann = parseAnnotation(raw);
    assert.equal(ann!.interest, 0);
  });

  it("clamps confidence similarly", () => {
    const raw = '{"file":"x","interest":5,"confidence":42,"note":"n"}';
    const ann = parseAnnotation(raw);
    assert.equal(ann!.confidence, 10);
  });

  it("returns null when file is missing", () => {
    const raw = '{"interest":5,"confidence":5,"note":"n"}';
    assert.equal(parseAnnotation(raw), null);
  });

  it("returns null when interest is not a number", () => {
    const raw = '{"file":"x","interest":"high","confidence":5,"note":"n"}';
    assert.equal(parseAnnotation(raw), null);
  });

  it("returns null on totally non-JSON input", () => {
    assert.equal(parseAnnotation("just some prose about what I did"), null);
  });

  it("treats missing note as empty string (not failure)", () => {
    const raw = '{"file":"x","interest":5,"confidence":5}';
    const ann = parseAnnotation(raw);
    assert.ok(ann);
    assert.equal(ann!.note, "");
  });
});

describe("formatAnnotations — ordering", () => {
  it("produces an empty-state message when table is empty", () => {
    const text = formatAnnotations(new Map());
    assert.match(text, /empty.*no files annotated yet/i);
  });

  it("sorts most-visited first, then alphabetically on ties", () => {
    const table = new Map<string, AnnotationState>([
      ["b.md", { visits: 1, avgInterest: 5, avgConfidence: 5, latestNote: "" }],
      ["a.md", { visits: 1, avgInterest: 5, avgConfidence: 5, latestNote: "" }],
      ["src/", { visits: 3, avgInterest: 8, avgConfidence: 4, latestNote: "core" }],
    ]);
    const text = formatAnnotations(table);
    const lines = text.split("\n");
    assert.ok(lines[0].startsWith("src/"), `expected src/ first, got ${lines[0]}`);
    assert.ok(lines[1].startsWith("a.md"), `expected a.md second (alphabetical tie), got ${lines[1]}`);
    assert.ok(lines[2].startsWith("b.md"));
  });
});

describe("buildExplorerPrompt — pheromone visibility", () => {
  it("includes current annotation table so agent sees the pheromone trail", () => {
    const table = new Map<string, AnnotationState>([
      ["src/foo.ts", { visits: 2, avgInterest: 8, avgConfidence: 3, latestNote: "complex" }],
    ]);
    const prompt = buildExplorerPrompt({
      agentIndex: 2,
      round: 1,
      totalRounds: 3,
      candidatePaths: ["src/", "README.md"],
      annotations: table,
    });
    assert.ok(prompt.includes("src/foo.ts"));
    assert.ok(prompt.includes("visits=2"));
    assert.match(prompt, /interest=8\.0/);
    assert.match(prompt, /confidence=3\.0/);
  });

  it("shows empty-table message when no annotations yet", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 1,
      round: 1,
      totalRounds: 1,
      candidatePaths: ["README.md"],
      annotations: new Map(),
    });
    assert.match(prompt, /empty.*no files annotated yet/i);
  });

  it("teaches the attractiveness rule (untouched / high-interest low-confidence)", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 1,
      round: 1,
      totalRounds: 1,
      candidatePaths: [],
      annotations: new Map(),
    });
    assert.match(prompt, /Untouched files are most attractive/i);
    assert.match(prompt, /high INTEREST \+ low CONFIDENCE/);
  });

  it("specifies the required annotation JSON shape", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 1,
      round: 1,
      totalRounds: 1,
      candidatePaths: [],
      annotations: new Map(),
    });
    assert.match(prompt, /"interest": 0-10/);
    assert.match(prompt, /"confidence": 0-10/);
    assert.match(prompt, /"note":/);
  });

  it("identifies the requesting agent by index in header + closing", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 5,
      round: 1,
      totalRounds: 1,
      candidatePaths: [],
      annotations: new Map(),
    });
    assert.ok(prompt.includes("You are Agent 5"));
    assert.ok(prompt.includes("Now respond as Agent 5."));
  });
});

describe("rankingScore — confidence-weighted + decay-aware (improvements #4 + #5)", () => {
  function annotation(overrides: Partial<AnnotationState>): AnnotationState {
    return {
      visits: 1,
      avgInterest: 5,
      avgConfidence: 5,
      latestNote: "x",
      ...overrides,
    };
  }

  it("base formula = visits × interest × (confidence/10) — no decay when round absent", () => {
    const a = annotation({ visits: 2, avgInterest: 10, avgConfidence: 10 });
    // 2 × 10 × 1 = 20
    assert.equal(rankingScore(a), 20);
  });

  it("low-confidence high-interest ranks BELOW high-confidence lower-interest", () => {
    const lowConf = annotation({ visits: 1, avgInterest: 10, avgConfidence: 2 });
    const highConf = annotation({ visits: 1, avgInterest: 8, avgConfidence: 9 });
    // lowConf:  1 × 10 × 0.2 = 2.0
    // highConf: 1 ×  8 × 0.9 = 7.2
    assert.ok(rankingScore(highConf) > rankingScore(lowConf));
  });

  it("decay applies when currentRound > lastVisitedRound", () => {
    const stale = annotation({ visits: 1, avgInterest: 10, avgConfidence: 10, lastVisitedRound: 1 });
    const fresh = annotation({ visits: 1, avgInterest: 10, avgConfidence: 10, lastVisitedRound: 3 });
    const currentRound = 3;
    // stale: 10 × decay^2 = 10 × 0.49 = 4.9
    // fresh: 10 × decay^0 = 10
    assert.ok(rankingScore(fresh, currentRound) > rankingScore(stale, currentRound));
    assert.equal(rankingScore(stale, currentRound), 10 * PHEROMONE_DECAY_PER_ROUND ** 2);
  });

  it("no decay when currentRound === lastVisitedRound (just-visited)", () => {
    const a = annotation({ visits: 1, avgInterest: 10, avgConfidence: 10, lastVisitedRound: 3 });
    assert.equal(rankingScore(a, 3), 10);
  });

  it("no decay when lastVisitedRound is missing (back-compat)", () => {
    const a = annotation({ visits: 1, avgInterest: 10, avgConfidence: 10 });
    // Should NOT decay even with currentRound set, because lastVisitedRound is undefined
    assert.equal(rankingScore(a, 5), 10);
  });

  it("multiple visits compound in score (visits multiplier)", () => {
    const single = annotation({ visits: 1, avgInterest: 5, avgConfidence: 5 });
    const triple = annotation({ visits: 3, avgInterest: 5, avgConfidence: 5 });
    assert.equal(rankingScore(triple), 3 * rankingScore(single));
  });
});

// 2026-05-02 (improvement #2): territory-plan prompt + parser tests.
import { buildTerritoryPlanPrompt, parseTerritoryPlan } from "./stigmergyPromptHelpers.js";

describe("buildTerritoryPlanPrompt", () => {
  it("includes directive, candidate paths, and explorer count", () => {
    const p = buildTerritoryPlanPrompt({
      directive: "audit auth flow",
      candidatePaths: ["src/", "tests/"],
      explorerCount: 3,
    });
    assert.match(p, /audit auth flow/);
    assert.match(p, /src\/, tests\//);
    assert.match(p, /EXPLORER COUNT: 3/);
  });

  it("requires JSON output with one key per explorer index", () => {
    const p = buildTerritoryPlanPrompt({
      directive: "x",
      candidatePaths: [],
      explorerCount: 2,
    });
    assert.match(p, /STRICT JSON/);
    assert.match(p, /"1":/);
    assert.match(p, /"2":/);
  });

  it("frames assignment as a SUGGESTION, not a constraint", () => {
    const p = buildTerritoryPlanPrompt({
      directive: "x",
      candidatePaths: [],
      explorerCount: 2,
    });
    assert.match(p, /SUGGESTION/);
    assert.match(p, /can wander/);
  });

  it("instructs to distribute coverage broadly", () => {
    const p = buildTerritoryPlanPrompt({
      directive: "x",
      candidatePaths: [],
      explorerCount: 3,
    });
    assert.match(p, /distribute coverage broadly/i);
    assert.match(p, /avoid sending two explorers to the same dir/i);
  });
});

describe("parseTerritoryPlan", () => {
  it("parses a clean JSON response", () => {
    const r = parseTerritoryPlan('{"1":"src/auth/","2":"src/api/","3":"tests/"}');
    assert.ok(r);
    assert.equal(r!.size, 3);
    assert.equal(r!.get(1), "src/auth/");
    assert.equal(r!.get(2), "src/api/");
    assert.equal(r!.get(3), "tests/");
  });

  it("strips ```json fences", () => {
    const r = parseTerritoryPlan('```json\n{"1":"x","2":"y"}\n```');
    assert.ok(r);
    assert.equal(r!.size, 2);
  });

  it("extracts JSON from surrounding prose", () => {
    const r = parseTerritoryPlan('Here is my plan:\n{"1":"a","2":"b"}\nLet me know!');
    assert.ok(r);
    assert.equal(r!.size, 2);
  });

  it("ignores non-numeric keys", () => {
    const r = parseTerritoryPlan('{"1":"a","x":"b","2":"c"}');
    assert.ok(r);
    assert.equal(r!.size, 2);
    assert.equal(r!.get(1), "a");
    assert.equal(r!.get(2), "c");
  });

  it("ignores empty/whitespace values", () => {
    const r = parseTerritoryPlan('{"1":"x","2":"","3":"   "}');
    assert.ok(r);
    assert.equal(r!.size, 1);
  });

  it("returns null on malformed JSON", () => {
    assert.equal(parseTerritoryPlan("not json"), null);
    assert.equal(parseTerritoryPlan(""), null);
    assert.equal(parseTerritoryPlan("{not valid"), null);
  });

  it("returns null on JSON array (not an object)", () => {
    assert.equal(parseTerritoryPlan('["a","b"]'), null);
  });

  it("returns null when no valid entries present", () => {
    assert.equal(parseTerritoryPlan('{"foo":"bar"}'), null);
    assert.equal(parseTerritoryPlan('{"1":""}'), null);
  });
});

// 2026-05-02 (improvement #1): explorer prompt rendering with new fields.
describe("buildExplorerPrompt — territory + recently-active (improvements #1 + #2)", () => {
  it("renders the YOUR ASSIGNED TERRITORY block when territory is set", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 2,
      round: 1,
      totalRounds: 3,
      candidatePaths: [],
      annotations: new Map(),
      territory: "src/auth/ — focus on the login flow",
    });
    assert.match(prompt, /YOUR ASSIGNED TERRITORY/);
    assert.match(prompt, /focus on the login flow/);
    assert.match(prompt, /SUGGESTION/);
  });

  it("OMITS the territory block when not set", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 1,
      round: 1,
      totalRounds: 1,
      candidatePaths: [],
      annotations: new Map(),
    });
    assert.doesNotMatch(prompt, /YOUR ASSIGNED TERRITORY/);
  });

  it("renders the RECENTLY ACTIVE block when peer activity exists", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 2,
      round: 2,
      totalRounds: 3,
      candidatePaths: [],
      annotations: new Map(),
      recentlyActive: [
        { file: "src/auth.ts", round: 1, note: "complex retry logic" },
        { file: "src/log.ts", round: 1, note: "trivial wrapper" },
      ],
    });
    assert.match(prompt, /RECENTLY ACTIVE/);
    assert.match(prompt, /src\/auth\.ts \(round 1\): complex retry logic/);
    assert.match(prompt, /src\/log\.ts \(round 1\): trivial wrapper/);
    assert.match(prompt, /VALIDATE\/REFUTE the recent annotations OR seek UNEXPLORED ground/);
  });

  it("OMITS the RECENTLY ACTIVE block when no peer activity (round 1)", () => {
    const prompt = buildExplorerPrompt({
      agentIndex: 1,
      round: 1,
      totalRounds: 3,
      candidatePaths: [],
      annotations: new Map(),
    });
    assert.doesNotMatch(prompt, /RECENTLY ACTIVE/);
  });
});
