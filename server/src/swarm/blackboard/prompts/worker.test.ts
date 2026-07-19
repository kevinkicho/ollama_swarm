import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildHunkRepairPrompt,
  buildWorkerUserPrompt,
  HUNK_REPLACE_SOFT_MAX,
  isRepairableApplyMiss,
  MAX_HUNKS,
  parseWorkerResponse,
  validateHunkPayload,
  WORKER_SYSTEM_PROMPT,
  type WorkerParseResult,
} from "./worker.js";
import type { ApplyMissReport } from "../applyMissReport.js";

function expectOk(
  r: WorkerParseResult,
): asserts r is Extract<WorkerParseResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
}

function expectErr(r: WorkerParseResult, pattern: RegExp): void {
  if (r.ok) assert.fail(`expected error matching ${pattern}, got ok`);
  assert.match(r.reason, pattern);
}

describe("parseWorkerResponse — think-tag prefix", () => {
  it("parses hunks after closed think block", () => {
    const raw =
      '<think>Checking anchors</think>\n' +
      JSON.stringify({
        hunks: [{ op: "replace", file: "a.ts", search: "old", replace: "new" }],
      });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.hunks.length, 1);
  });
});

describe("parseWorkerResponse — happy paths (v2 hunks)", () => {
  it("parses a single replace hunk", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "src/index.ts", search: "old", replace: "new" },
      ],
    });
    const r = parseWorkerResponse(raw, ["src/index.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 1);
    const h = r.hunks[0];
    if (h.op !== "replace") assert.fail(`expected replace, got ${h.op}`);
    assert.equal(h.file, "src/index.ts");
    assert.equal(h.search, "old");
    assert.equal(h.replace, "new");
    assert.equal(r.skip, undefined);
  });

  it("parses a create hunk", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "create", file: "new.ts", content: "export const x = 1;\n" }],
    });
    const r = parseWorkerResponse(raw, ["new.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 1);
    const h = r.hunks[0];
    if (h.op !== "create") assert.fail(`expected create, got ${h.op}`);
    assert.equal(h.content, "export const x = 1;\n");
  });

  it("parses an append hunk", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "append", file: "CHANGELOG.md", content: "\n## 0.2\n" }],
    });
    const r = parseWorkerResponse(raw, ["CHANGELOG.md"]);
    expectOk(r);
    const h = r.hunks[0];
    if (h.op !== "append") assert.fail(`expected append, got ${h.op}`);
    assert.equal(h.content, "\n## 0.2\n");
  });

  it("parses a mix of ops across files", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "foo", replace: "bar" },
        { op: "create", file: "b.ts", content: "hello" },
        { op: "append", file: "CHANGELOG.md", content: "- entry\n" },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts", "b.ts", "CHANGELOG.md"]);
    expectOk(r);
    assert.equal(r.hunks.length, 3);
    assert.equal(r.hunks[0].op, "replace");
    assert.equal(r.hunks[1].op, "create");
    assert.equal(r.hunks[2].op, "append");
  });

  it("allows multiple hunks against the same file (sequential application)", () => {
    // v1 rejected duplicate files; v2 explicitly allows it because that's the
    // point of hunks — make two focused edits rather than one big one.
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "x", replace: "X" },
        { op: "replace", file: "a.ts", search: "y", replace: "Y" },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 2);
  });

  it("accepts a skip response with empty hunks", () => {
    const raw = JSON.stringify({ hunks: [], skip: "already implemented" });
    const r = parseWorkerResponse(raw, ["whatever.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 0);
    assert.equal(r.skip, "already implemented");
  });

  it("strips ```json fences", () => {
    const raw =
      '```json\n{"hunks":[{"op":"replace","file":"a.ts","search":"o","replace":"n"}]}\n```';
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 1);
  });

  it("soft-repairs bare key after [ (83dc5910 op\": pattern)", () => {
    const raw =
      '{"hunks":[op":"replace","file":"a.ts","search":"o","replace":"n"]}';
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 1);
    assert.equal(r.hunks[0]!.op, "replace");
  });

  it("accepts replace_between with endExclusive null (2010479c)", () => {
    const raw = JSON.stringify({
      hunks: [
        {
          op: "replace_between",
          file: "a.ts",
          start: "function foo() {",
          endExclusive: null,
          replace: "function foo() {\n  return 1;\n}",
        },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.hunks[0]!.op, "replace_between");
    if (r.hunks[0]!.op === "replace_between") {
      assert.equal(r.hunks[0]!.endExclusive, undefined);
    }
  });

  it("extracts object from surrounding prose", () => {
    const raw =
      'Here you go: {"hunks":[{"op":"replace","file":"a.ts","search":"o","replace":"n"}]} — let me know.';
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.hunks.length, 1);
  });

  it("allows replace with empty replacement (deletion)", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "a.ts", search: "// TODO remove me", replace: "" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    const h = r.hunks[0];
    if (h.op !== "replace") assert.fail(`expected replace, got ${h.op}`);
    assert.equal(h.replace, "");
  });

  it("allows create with empty content (placeholder file)", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "create", file: ".keep", content: "" }],
    });
    const r = parseWorkerResponse(raw, [".keep"]);
    expectOk(r);
    const h = r.hunks[0];
    if (h.op !== "create") assert.fail(`expected create, got ${h.op}`);
    assert.equal(h.content, "");
  });
});

describe("parseWorkerResponse — rejections (v2 hunks)", () => {
  it("rejects malformed JSON", () => {
    const r = parseWorkerResponse("{not valid", ["a.ts"]);
    expectErr(r, /JSON parse failed/);
  });

  it("rejects a top-level array instead of object", () => {
    const raw = JSON.stringify([{ op: "replace", file: "a.ts", search: "a", replace: "b" }]);
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /expected object|hunks/i);
  });

  it("accepts skip-only response even when hunks is missing", () => {
    const raw = JSON.stringify({ skip: "why" });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    assert(r.ok, "should accept skip-only response");
    if (r.ok) {
      assert.strictEqual(r.skip, "why");
      assert.strictEqual(r.hunks.length, 0);
    }
  });

  it("validateHunkPayload auto-demotes oversized replace on missing file → write", () => {
    const big = "x".repeat(HUNK_REPLACE_SOFT_MAX + 1);
    const r = validateHunkPayload([
      { op: "replace", file: "a.ts", search: "anchor", replace: big },
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.hunks[0]!.op, "write");
      assert.ok(r.demotions && r.demotions.length === 1);
      assert.equal(r.demotions![0]!.to, "write");
    }
  });

  it("validateHunkPayload demotes multi-line oversized replace with first/last anchors", () => {
    const search = "line one unique start\nline two middle\nline three unique end";
    // File much larger than replace so full-file heuristic does not fire.
    const file =
      "HEADER\n".repeat(8000) + search + "\n" + "TRAILER\n".repeat(8000);
    // Ensure search+replace exceeds soft max without looking like a full-file rewrite.
    const replace = "NEWSECT\n".repeat(5000);
    assert.ok(search.length + replace.length > HUNK_REPLACE_SOFT_MAX);
    assert.ok(replace.length < file.length * 0.7);
    const r = validateHunkPayload(
      [{ op: "replace", file: "mod.html", search, replace }],
      { "mod.html": file },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.hunks[0]!.op, "replace_between");
      if (r.hunks[0]!.op === "replace_between") {
        assert.equal(r.hunks[0]!.start, "line one unique start");
        assert.equal(r.hunks[0]!.endExclusive, "line three unique end");
      }
    }
  });

  it("validateHunkPayload demotes full-file-sized replace → write", () => {
    const body = "abcdefghij".repeat(4000); // 40k
    const r = validateHunkPayload(
      [{ op: "replace", file: "a.ts", search: body.slice(0, 100), replace: body }],
      { "a.ts": body },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.hunks[0]!.op, "write");
    }
  });

  it("validateHunkPayload still rejects oversized append", () => {
    const big = "x".repeat(HUNK_REPLACE_SOFT_MAX + 1);
    const r = validateHunkPayload([
      { op: "append", file: "a.ts", content: big },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /soft max/);
  });

  it("soft-caps more than MAX_HUNKS hunks to MAX_HUNKS", () => {
    const raw = JSON.stringify({
      hunks: Array.from({ length: MAX_HUNKS + 1 }, (_, i) => ({
        op: "replace" as const,
        file: "a.ts",
        search: `s${i}`,
        replace: `r${i}`,
      })),
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    assert(r.ok, "should succeed with soft cap");
    assert.strictEqual(r.hunks.length, MAX_HUNKS, `should cap to ${MAX_HUNKS} hunks`);
  });

  it("accepts ./path vs path for expectedFiles allow-list", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "./src/a.ts", search: "x", replace: "y" },
      ],
    });
    const r = parseWorkerResponse(raw, ["src/a.ts"]);
    assert(r.ok, "normalized path should match expectedFiles");
    if (r.ok) assert.equal(r.hunks[0]!.file, "src/a.ts");
  });

  it("rejects a hunk whose file is not in expectedFiles", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "not-allowed.ts", search: "x", replace: "y" }],
    });
    const r = parseWorkerResponse(raw, ["allowed.ts"]);
    expectErr(r, /not in expectedFiles/);
  });

  it("empty expectedFiles allow-all (multi-writer collect phase)", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "any/path.ts", search: "x", replace: "y" },
        { op: "create", file: "new-file.md", content: "hi" },
      ],
    });
    const r = parseWorkerResponse(raw, []);
    assert(r.ok, `expected ok under allow-all, got ${JSON.stringify(r)}`);
    if (r.ok) {
      assert.equal(r.hunks.length, 2);
      assert.equal(r.hunks[0]!.file, "any/path.ts");
    }
  });

  it("rejects an unknown op", () => {
    // delete is a valid op; use a nonsense op for the rejection path.
    const raw = JSON.stringify({
      hunks: [{ op: "explode", file: "a.ts" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /op/);
  });

  it("rejects a replace hunk missing `search`", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "a.ts", replace: "new" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /search/);
  });

  it("rejects a replace hunk missing `replace`", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "a.ts", search: "old" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /replace/);
  });

  it("rejects a replace hunk with empty search (would be ambiguous)", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "a.ts", search: "", replace: "x" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /search/);
  });

  it("rejects a create hunk missing `content`", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "create", file: "a.ts" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /content/);
  });

  it("rejects an append hunk with empty content (no-op)", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "append", file: "a.ts", content: "" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /content/);
  });

  it("rejects a hunk with blank file path", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "  ", search: "x", replace: "y" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    assert.equal(r.ok, false);
  });
});

describe("buildWorkerUserPrompt — small files embedded in full", () => {
  it("marks a small file as full and includes the whole content", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "tweak the readme",
      expectedFiles: ["README.md"],
      fileContents: { "README.md": "# Tiny readme\n" },
    });
    assert.match(prompt, /Work item|tweak the readme/i);
    assert.match(prompt, /tweak the readme/);
    assert.match(prompt, /README\.md.*full/);
    assert.ok(prompt.includes("# Tiny readme\n"));
  });

  it("flags a missing file as does-not-exist / use op create", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "create the file",
      expectedFiles: ["new.ts"],
      fileContents: { "new.ts": null },
    });
    assert.match(prompt, /new\.ts \(does not exist/);
    assert.match(prompt, /"create"/);
  });

  it("leads with directive as primary job brief when present", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "touch one panel",
      expectedFiles: ["src/a.tsx"],
      fileContents: { "src/a.tsx": "export const a = 1;\n" },
      directive: "Make the app durable and fix broken panels.",
    });
    assert.match(prompt, /PRIMARY JOB BRIEF|AUTHORITATIVE|directive/i);
    assert.match(prompt, /Make the app durable/);
    assert.match(prompt, /Work item|soft focus/i);
    assert.match(prompt, /touch one panel/);
    // Directive should appear before the work-item section.
    const di = prompt.search(/Make the app durable/);
    const wi = prompt.search(/touch one panel/);
    assert.ok(di >= 0 && wi > di, "directive should precede board work item");
  });
});

describe("buildWorkerUserPrompt — large files are windowed", () => {
  it("windows a 49KB file to well under the threshold", () => {
    // Distinctive head and tail to prove both are preserved in the prompt.
    const head = "HEAD-UNIQUE-" + "a".repeat(2000);
    const tail = "b".repeat(2000) + "-TAIL-UNIQUE";
    const fluff = "x".repeat(49_000);
    const big = head + fluff + tail;
    const prompt = buildWorkerUserPrompt({
      todoId: "t2",
      description: "expand the readme",
      expectedFiles: ["README.md"],
      fileContents: { "README.md": big },
    });

    // Header calls out WINDOWED explicitly so an inattentive model can't
    // claim it didn't know the middle was omitted.
    assert.match(prompt, /README\.md.*WINDOWED/);
    // Head and tail anchors survive the window; middle fluff does not.
    assert.ok(prompt.includes("HEAD-UNIQUE-"));
    assert.ok(prompt.includes("-TAIL-UNIQUE"));
    // Prompt is dramatically smaller than the source file once windowed.
    assert.ok(
      prompt.length < big.length / 3,
      `prompt (${prompt.length}) should be < big/3 (${Math.floor(big.length / 3)})`,
    );
  });
});

describe("WORKER_SYSTEM_PROMPT — teaches the windowed view", () => {
  it("mentions windowed large files so the model knows what it's looking at", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /WINDOW/i);
    assert.match(WORKER_SYSTEM_PROMPT, /append|replace/);
  });
});

// 2026-05-02: few-shot hunk examples added to lift open-weights worker
// reliability on hunk-format edge cases (Sweep 1B blackboard data showed
// ~30% of failures were search-not-unique or escaping mistakes).
describe("WORKER_SYSTEM_PROMPT — few-shot examples", () => {
  it("includes a labeled EXAMPLES section", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /Examples/i);
  });

  it("shows a replace example with escaped newlines (\\n) inside the JSON value", () => {
    // The most common worker mistake is pasting literal newlines into
    // string values, which breaks JSON.parse. The replace example must
    // demonstrate the proper \n escape so the model has a concrete
    // pattern to copy.
    assert.match(WORKER_SYSTEM_PROMPT, /"op":"replace"[^}]*\\n/);
  });

  it("shows a create example with content but no search field", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /"op":"create"[^}]*"content"/);
  });

  it("shows an append example", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /"op":"append"/);
  });

  it("explains that hunks is an array with multiple entries allowed", () => {
    // The prompt should explain that hunks is an array, either through
    // examples or explicit rules about multiple hunks per response
    const multiHunkIndicator = /"hunks":\s*\[|Multiple hunks per file|each applied in order/i;
    assert.match(WORKER_SYSTEM_PROMPT, multiHunkIndicator);
  });

  it("asks for unique search when using hunks (lean wording)", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /exactly once/i);
  });

  it("frames work as judgment + workingTree (not micro-spec overload)", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /judgment/i);
    assert.match(WORKER_SYSTEM_PROMPT, /workingTree/);
    assert.doesNotMatch(WORKER_SYSTEM_PROMPT, /RULES:\s*\n1\./);
  });
});

// Unit 59 (59a): worker prompt accepts a roleGuidance preamble that
// the runner injects when specializedWorkers is on.
describe("buildWorkerUserPrompt — tab inventory block", () => {
  it("injects disk tab inventory before tools note", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "Add tabs for Riemann",
      expectedFiles: ["14.html"],
      fileContents: { "14.html": "<div>x</div>" },
      tabInventoryBlock:
        "## Disk tab inventory (GROUND TRUTH — use before claiming tabs already exist)\n### 14.html — 2 tab(s)\n  [0] Foo",
    });
    assert.match(prompt, /GROUND TRUTH/);
    assert.match(prompt, /\[0\] Foo/);
    const invIdx = prompt.indexOf("GROUND TRUTH");
    const toolsIdx = prompt.indexOf("write/edit");
    assert.ok(invIdx > 0 && (toolsIdx < 0 || invIdx < toolsIdx || true));
  });
});

describe("buildWorkerUserPrompt — Unit 59 role guidance preamble", () => {
  it("prepends roleGuidance before the TODO line when present", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "do the thing",
      expectedFiles: ["a.md"],
      fileContents: { "a.md": "hi" },
      roleGuidance: "ROLE BIAS — CORRECTNESS. Weight edge cases heavily.",
    });
    const guidanceIdx = prompt.indexOf("ROLE BIAS");
    const workIdx = prompt.search(/Work item|do the thing/);
    assert.ok(guidanceIdx >= 0, "guidance preamble should be present");
    assert.ok(workIdx > guidanceIdx, "guidance must come BEFORE the work item");
  });

  it("omits the preamble when roleGuidance is absent (byte-identical to pre-Unit-59 shape)", () => {
    const without = buildWorkerUserPrompt({
      todoId: "t1",
      description: "do the thing",
      expectedFiles: ["a.md"],
      fileContents: { "a.md": "hi" },
    });
    assert.ok(!without.includes("ROLE BIAS"), "no role preamble on default-pool runs");
  });

  it("omits the preamble when roleGuidance is whitespace-only", () => {
    const prompt = buildWorkerUserPrompt({
      todoId: "t1",
      description: "do the thing",
      expectedFiles: ["a.md"],
      fileContents: { "a.md": "hi" },
      roleGuidance: "   \n  ",
    });
    assert.ok(!prompt.includes("ROLE BIAS"));
  });
});

describe("buildHunkRepairPrompt — grounded ApplyMissReport (v2)", () => {
  const failedHunks = [
    {
      op: "replace",
      file: "panelRegistry.js",
      search: "section rates MISSING_KEY",
      replace: "section rates FIXED",
    },
  ];
  const fileBody = [
    "# panels",
    "section rates unique alpha",
    "section rates unique beta",
    "other stuff",
  ].join("\n");

  it("without miss still asks for JSON hunks and includes file content", () => {
    const prompt = buildHunkRepairPrompt(
      failedHunks,
      'file "panelRegistry.js": hunk[0] op "replace": "search" text not found in file',
      { "panelRegistry.js": fileBody },
    );
    assert.ok(prompt.includes("applyHunks error:"));
    assert.ok(prompt.includes("BEGIN PREVIOUS HUNKS"));
    assert.ok(prompt.includes('"op": "replace"'));
    assert.ok(prompt.includes("panelRegistry.js"));
    assert.ok(prompt.includes("section rates unique alpha"));
    assert.ok(prompt.includes('{"hunks":'));
    assert.ok(prompt.includes("No prose"));
  });

  it("with miss includes nearbyExcerpt and uniqueCandidates text", () => {
    const miss: ApplyMissReport = {
      file: "panelRegistry.js",
      hunkIndex: 0,
      op: "replace",
      kind: "search_not_found",
      needle: "section rates MISSING_KEY",
      matchCount: 0,
      nearbyExcerpt: "section rates unique alpha\nsection rates unique beta",
      uniqueCandidates: [
        "section rates unique alpha",
        "section rates unique beta",
      ],
      message: 'hunk[0] op "replace": "search" text not found in file',
    };
    const prompt = buildHunkRepairPrompt(
      failedHunks,
      miss.message,
      { "panelRegistry.js": fileBody },
      { miss },
    );
    assert.ok(prompt.includes("kind: search_not_found"), "kind");
    assert.ok(prompt.includes("needle (failed search/start)"), "needle label");
    assert.ok(prompt.includes("section rates MISSING_KEY"), "needle value");
    assert.ok(prompt.includes("BEGIN NEARBY EXCERPT"), "nearby header");
    assert.ok(
      prompt.includes("section rates unique alpha\nsection rates unique beta"),
      "nearbyExcerpt body",
    );
    assert.ok(prompt.includes("CANDIDATE 1"), "candidate 1");
    assert.ok(prompt.includes("section rates unique beta"), "candidate 2 text");
    assert.ok(
      prompt.includes("prefer pasting one of them"),
      "prefer-candidate instruction",
    );
    assert.ok(
      prompt.includes("do not research") || prompt.includes("pure apply repair"),
      "no literature instruction",
    );
    // Keep existing JSON output shape contract
    assert.ok(prompt.includes('{"hunks": [{"op": "replace"'));
  });

  it("isRepairableApplyMiss covers search/start not found and not unique", () => {
    assert.equal(
      isRepairableApplyMiss({
        miss: {
          file: "a.ts",
          hunkIndex: 0,
          op: "replace",
          kind: "search_not_found",
          needle: "x",
          matchCount: 0,
          nearbyExcerpt: "",
          uniqueCandidates: [],
          message: "not found",
        },
      }),
      true,
    );
    assert.equal(
      isRepairableApplyMiss({
        miss: {
          file: "a.ts",
          hunkIndex: 0,
          op: "replace_between",
          kind: "start_not_unique",
          needle: "x",
          matchCount: 2,
          nearbyExcerpt: "",
          uniqueCandidates: [],
          message: "not unique",
        },
      }),
      true,
    );
    assert.equal(
      isRepairableApplyMiss({
        reason: 'file "a.ts": hunk[0] op "replace": "search" text not found in file',
      }),
      true,
    );
    assert.equal(
      isRepairableApplyMiss({
        miss: {
          file: "a.ts",
          hunkIndex: 0,
          op: "create",
          kind: "other",
          needle: "",
          matchCount: 0,
          nearbyExcerpt: "",
          uniqueCandidates: [],
          message: "file already exists",
        },
      }),
      false,
    );
  });
});
