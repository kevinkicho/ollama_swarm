import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildPlannerUserPrompt,
  parsePlannerResponse,
  coercePlannerTodoItem,
  salvagePlannerTodosFromDropped,
  extractFileMentions,
  PLANNER_SYSTEM_PROMPT,
  type PlannerParseResult,
  type PlannerSeed,
} from "./planner.js";

function seed(overrides: Partial<PlannerSeed> = {}): PlannerSeed {
  return {
    repoUrl: "https://github.com/x/y",
    clonePath: "/tmp/y",
    topLevel: ["README.md", "src"],
    repoFiles: ["README.md", "src/index.ts"],
    readmeExcerpt: "# y\n",
    ...overrides,
  };
}

function expectOk(
  r: PlannerParseResult,
): asserts r is Extract<PlannerParseResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
}

describe("parsePlannerResponse — happy paths", () => {
  it("parses a flat JSON array", () => {
    const raw = JSON.stringify([
      { description: "Add a CONTRIBUTING doc", expectedFiles: ["CONTRIBUTING.md"] },
      { description: "Rename export in index.js", expectedFiles: ["src/index.js", "src/index.test.js"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.equal(r.todos[0].description, "Add a CONTRIBUTING doc");
    assert.deepEqual(r.todos[1].expectedFiles, ["src/index.js", "src/index.test.js"]);
    assert.equal(r.dropped.length, 0);
  });

  it("strips ```json fences", () => {
    const raw = '```json\n[{"description":"a","expectedFiles":["x.ts"]}]\n```';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0].description, "a");
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n[{"description":"a","expectedFiles":["x.ts"]}]\n```';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
  });

  it("extracts array from surrounding prose", () => {
    const raw = 'Here is the plan: [{"description":"a","expectedFiles":["x.ts"]}] Let me know!';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
  });

  it("allows an empty array (planner says nothing to do)", () => {
    const r = parsePlannerResponse("[]");
    expectOk(r);
    assert.equal(r.todos.length, 0);
    assert.equal(r.dropped.length, 0);
  });
});

describe("parsePlannerResponse — rejections", () => {
  it("rejects malformed JSON", () => {
    const r = parsePlannerResponse("{not valid");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /JSON parse failed/);
  });

  it("rejects a top-level object that doesn't look like a todo (#121)", () => {
    // 2026-05-01 (#121): leniency only kicks in when the object has a
    // "description" field. A bare { foo: 1 } is still rejected so we
    // don't accept arbitrary garbage.
    const r = parsePlannerResponse('{"foo":1,"bar":2}');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /top-level JSON array/);
  });

  it("auto-wraps a single todo-shaped object as [todo] (#121)", () => {
    // Live observed 2026-05-01 PM: planner emitted a perfectly valid
    // single todo, parser rejected with "expected top-level JSON array",
    // repair prompt fired, repair returned [] → run no-progress'd. Fix:
    // when the object has a "description" field, wrap it for the planner.
    const r = parsePlannerResponse('{"description":"Read src/log.js","expectedFiles":["src/log.js"]}');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.todos.length, 1);
      assert.equal(r.todos[0].description, "Read src/log.js");
      assert.deepEqual(r.todos[0].expectedFiles, ["src/log.js"]);
    }
  });

  it("auto-wrap still validates the object — bad single todos land in dropped (#121)", () => {
    // Wrapping just gives the per-item walk a chance to validate. A
    // single-item object missing required fields gets dropped (not
    // accepted blindly) when no file can be inferred from the text.
    const r = parsePlannerResponse('{"description":"missing expectedFiles"}');
    // Per-item validator drops it for missing expectedFiles → 0 valid
    // todos + 1 dropped entry. Result is technically `ok` (we parsed
    // something), but no todos → planner-empty handling fires upstream.
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.todos.length, 0);
      assert.equal(r.dropped.length, 1);
    }
  });

  it("coerces expectedFiles string + file alias (d279548d schema salvage)", () => {
    const r = parsePlannerResponse(
      JSON.stringify([
        { description: "Expand tabs", expectedFiles: "01_complex_explorer.html" },
        { task: "Fix blank canvas in 02_penrose_tiling.html", file: "02_penrose_tiling.html" },
      ]),
    );
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.deepEqual(r.todos[0]!.expectedFiles, ["01_complex_explorer.html"]);
    assert.equal(r.todos[1]!.description.includes("Fix blank canvas"), true);
    assert.deepEqual(r.todos[1]!.expectedFiles, ["02_penrose_tiling.html"]);
  });

  it("accepts {todos:[...]} envelope", () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        todos: [{ description: "Add tour", expectedFiles: ["tour-data.js"] }],
      }),
    );
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0]!.expectedFiles[0], "tour-data.js");
  });

  it("infers expectedFiles from description path mentions", () => {
    const r = parsePlannerResponse(
      JSON.stringify([
        { description: "Expand tab bar in 35_black_holes.html to ≥10 tabs" },
      ]),
    );
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.deepEqual(r.todos[0]!.expectedFiles, ["35_black_holes.html"]);
  });

  it("strips trailing slash from directory-like expectedFiles", () => {
    const r = parsePlannerResponse(
      JSON.stringify([
        { description: "Touch module", expectedFiles: ["src/app.ts/"] },
      ]),
    );
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.deepEqual(r.todos[0]!.expectedFiles, ["src/app.ts"]);
  });

  it("extractFileMentions finds html modules", () => {
    const m = extractFileMentions("work on 01_complex_explorer.html and src/x.ts please");
    assert.ok(m.includes("01_complex_explorer.html"));
    assert.ok(m.includes("src/x.ts"));
  });

  it("salvagePlannerTodosFromDropped rebounds basenames against repoFiles", () => {
    const salvaged = salvagePlannerTodosFromDropped(
      [
        {
          reason: "expectedFiles: Required",
          raw: { description: "Expand complex explorer tabs", path: "01_complex_explorer.html" },
        },
      ],
      ["01_complex_explorer.html", "02_penrose_tiling.html"],
    );
    assert.equal(salvaged.length, 1);
    assert.deepEqual(salvaged[0]!.expectedFiles, ["01_complex_explorer.html"]);
  });

  it("coercePlannerTodoItem demotes build without command to hunks", () => {
    const c = coercePlannerTodoItem({
      kind: "build",
      description: "x",
      expectedFiles: ["a.ts"],
    }) as Record<string, unknown>;
    assert.equal(c.kind, undefined);
  });

  it("soft-caps to MAX_TODOS_PER_BATCH when more valid todos than the limit", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      description: `task ${i}`,
      expectedFiles: [`f${i}.ts`],
    }));
    const r = parsePlannerResponse(JSON.stringify(many));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.todos.length, 5); // MAX_TODOS_PER_BATCH
  });
});

describe("parsePlannerResponse — drops invalid items", () => {
  it("drops items missing description and keeps valid ones", () => {
    const raw = JSON.stringify([
      { description: "good", expectedFiles: ["a.ts"] },
      { expectedFiles: ["b.ts"] },
      { description: "good2", expectedFiles: ["c.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.equal(r.dropped.length, 1);
  });

  it("truncates items with more than 2 expectedFiles to first 2", () => {
    const raw = JSON.stringify([
      { description: "ok", expectedFiles: ["a.ts"] },
      { description: "too big", expectedFiles: ["a.ts", "b.ts", "c.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.equal(r.dropped.length, 0);
    assert.deepEqual(r.todos[1].expectedFiles, ["a.ts", "b.ts"]);
  });

  it("drops items with empty expectedFiles list", () => {
    const raw = JSON.stringify([
      { description: "no files", expectedFiles: [] },
      { description: "ok", expectedFiles: ["a.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 1);
  });

  it("drops items whose description is blank after trim", () => {
    const raw = JSON.stringify([
      { description: "   ", expectedFiles: ["a.ts"] },
      { description: "ok", expectedFiles: ["b.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 1);
  });

  it("drops items whose expectedFiles include a directory path (trailing / or \\)", () => {
    const raw = JSON.stringify([
      { description: "ok", expectedFiles: ["src/index.ts"] },
      { description: "fwd slash dir", expectedFiles: ["src/"] },
      { description: "backslash dir", expectedFiles: ["src\\"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 2);
    assert.match(r.dropped[0].reason, /file path, not a directory/);
    assert.match(r.dropped[1].reason, /file path, not a directory/);
  });
});

// Grounding Unit 6a: user prompt renders REPO FILE LIST; system prompt
// instructs the planner to ground expectedFiles in that list.
describe("planner prompts — repo grounding (Unit 6a)", () => {
  it("user prompt renders REPO FILE LIST with one path per line", () => {
    const p = buildPlannerUserPrompt(
      seed({ repoFiles: ["README.md", "src/a.ts", "src/lib/b.ts"] }),
    );
    assert.match(p, /=== REPO FILE LIST/);
    assert.match(p, /=== end REPO FILE LIST/);
    assert.match(p, /\nREADME\.md\n/);
    assert.match(p, /\nsrc\/a\.ts\n/);
    assert.match(p, /\nsrc\/lib\/b\.ts\n/);
  });

  it("user prompt falls back gracefully when repoFiles is empty", () => {
    const p = buildPlannerUserPrompt(seed({ repoFiles: [] }));
    assert.match(p, /no files listed/);
    assert.match(p, /=== REPO FILE LIST/);
  });

  it("system prompt instructs planner to ground expectedFiles in REPO FILE LIST", () => {
    assert.match(PLANNER_SYSTEM_PROMPT, /REPO FILE LIST/);
  });
});
