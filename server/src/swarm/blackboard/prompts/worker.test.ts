import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerParseResult,
} from "./worker.js";

function expectOk(
  r: WorkerParseResult,
): asserts r is Extract<WorkerParseResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
}

function expectErr(r: WorkerParseResult, pattern: RegExp): void {
  if (r.ok) assert.fail(`expected error matching ${pattern}, got ok`);
  assert.match(r.reason, pattern);
}

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

  it("rejects missing `hunks` field", () => {
    const raw = JSON.stringify({ skip: "why" });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /hunks/);
  });

  it("rejects more than 8 hunks", () => {
    const raw = JSON.stringify({
      hunks: Array.from({ length: 9 }, (_, i) => ({
        op: "replace" as const,
        file: "a.ts",
        search: `s${i}`,
        replace: `r${i}`,
      })),
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /hunks/);
  });

  it("rejects a hunk whose file is not in expectedFiles", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "replace", file: "not-allowed.ts", search: "x", replace: "y" }],
    });
    const r = parseWorkerResponse(raw, ["allowed.ts"]);
    expectErr(r, /not in expectedFiles/);
  });

  it("rejects an unknown op", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "delete", file: "a.ts" }],
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
    assert.match(prompt, /TODO: tweak the readme/);
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
    // Prompt is dramatically smaller than the source file. 49KB should land
    // under ~10KB of total user prompt once windowed.
    assert.ok(
      prompt.length < big.length / 4,
      `prompt (${prompt.length}) should be < big/4 (${Math.floor(big.length / 4)})`,
    );
  });
});

describe("WORKER_SYSTEM_PROMPT — teaches the windowed view", () => {
  it("mentions windowed large files so the model knows what it's looking at", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /WINDOW/i);
    assert.match(WORKER_SYSTEM_PROMPT, /append|replace/);
  });
});

// Unit 59 (59a): worker prompt accepts a roleGuidance preamble that
// the runner injects when specializedWorkers is on.
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
    const todoIdx = prompt.indexOf("TODO:");
    assert.ok(guidanceIdx >= 0, "guidance preamble should be present");
    assert.ok(todoIdx > guidanceIdx, "guidance must come BEFORE the TODO line");
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
