import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnnotation,
  buildExplorerPrompt,
  formatAnnotations,
  type AnnotationState,
} from "./StigmergyRunner.js";

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
