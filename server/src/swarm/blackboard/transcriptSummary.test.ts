import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgentResponse } from "./transcriptSummary.js";

describe("summarizeAgentResponse — worker hunks", () => {
  it("summarizes a single replace hunk", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "src/a.ts", search: "foo", replace: "bar" },
      ],
    });
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    assert.equal(s!.kind, "worker_hunks");
    if (s!.kind !== "worker_hunks") return;
    assert.equal(s!.hunkCount, 1);
    assert.deepEqual(s!.ops, { replace: 1, create: 0, append: 0 });
    assert.equal(s!.firstFile, "src/a.ts");
    assert.equal(s!.multipleFiles, false);
    // search "foo" + replace "bar" = 6 chars
    assert.equal(s!.totalChars, 6);
  });

  it("summarizes mixed-op hunks across multiple files", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "src/a.ts", search: "old", replace: "new" },
        { op: "create", file: "src/b.ts", content: "// hi\n" },
        { op: "append", file: "src/a.ts", content: "// foot\n" },
      ],
    });
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    if (s!.kind !== "worker_hunks") assert.fail("expected worker_hunks");
    assert.equal(s!.hunkCount, 3);
    assert.deepEqual(s!.ops, { replace: 1, create: 1, append: 1 });
    assert.equal(s!.firstFile, "src/a.ts");
    assert.equal(s!.multipleFiles, true);
  });

  it("treats empty hunks: [] as a no-op skip", () => {
    const raw = JSON.stringify({ hunks: [] });
    const s = summarizeAgentResponse(raw);
    assert.equal(s?.kind, "worker_skip");
    if (s?.kind !== "worker_skip") return;
    assert.match(s.reason, /empty hunks/i);
  });
});

describe("summarizeAgentResponse — worker skip", () => {
  it("recognizes hunks: [] + skip: 'reason'", () => {
    const raw = JSON.stringify({ hunks: [], skip: "rows in omitted middle" });
    const s = summarizeAgentResponse(raw);
    assert.equal(s?.kind, "worker_skip");
    if (s?.kind !== "worker_skip") return;
    assert.equal(s.reason, "rows in omitted middle");
  });

  it("recognizes a bare skip object (no hunks key)", () => {
    const raw = JSON.stringify({ skip: "no work to do" });
    const s = summarizeAgentResponse(raw);
    assert.equal(s?.kind, "worker_skip");
    if (s?.kind !== "worker_skip") return;
    assert.equal(s.reason, "no work to do");
  });

  it("treats whitespace-only skip as not a skip (falls through)", () => {
    const raw = JSON.stringify({ skip: "   " });
    const s = summarizeAgentResponse(raw);
    // Without hunks AND with empty skip, we have no useful summary.
    assert.equal(s, undefined);
  });
});

describe("summarizeAgentResponse — extraction edge cases", () => {
  it("extracts JSON from a ```json fenced block", () => {
    const raw = '```json\n{"hunks":[{"op":"create","file":"x.md","content":"y"}]}\n```';
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    if (s!.kind !== "worker_hunks") assert.fail("expected worker_hunks");
    assert.equal(s!.firstFile, "x.md");
  });

  it("extracts JSON from a bare ``` fenced block (no `json` tag)", () => {
    const raw = '```\n{"skip":"nope"}\n```';
    const s = summarizeAgentResponse(raw);
    assert.equal(s?.kind, "worker_skip");
  });

  it("extracts JSON from prose-then-object surround", () => {
    const raw = 'Here is my response:\n{"hunks":[{"op":"create","file":"y.md","content":"z"}]}\nThanks!';
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    if (s!.kind !== "worker_hunks") assert.fail("expected worker_hunks");
    assert.equal(s!.firstFile, "y.md");
  });

  it("returns undefined for prose-only / non-JSON text", () => {
    assert.equal(summarizeAgentResponse("Just thinking out loud here."), undefined);
    assert.equal(summarizeAgentResponse(""), undefined);
    assert.equal(summarizeAgentResponse("   "), undefined);
  });

  it("returns undefined for unrecognized JSON shape", () => {
    // Auditor-style verdict — server-side summarizer doesn't emit this kind
    // (yet); UI's client-side summarizer handles it. We're explicit that
    // this returns undefined so the UI knows to fall through.
    const raw = JSON.stringify({ verdicts: [{ id: "c1", status: "met" }] });
    assert.equal(summarizeAgentResponse(raw), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(summarizeAgentResponse("{not valid json"), undefined);
    assert.equal(summarizeAgentResponse("```json\nbroken\n```"), undefined);
  });
});

describe("summarizeAgentResponse — robustness", () => {
  it("ignores hunks without a recognized op", () => {
    const raw = JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "x", replace: "y" },
        { op: "delete-everything", file: "a.ts" },
      ],
    });
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    if (s!.kind !== "worker_hunks") assert.fail();
    // The unknown-op hunk is excluded from the count + ops breakdown.
    assert.equal(s!.hunkCount, 1);
    assert.deepEqual(s!.ops, { replace: 1, create: 0, append: 0 });
  });

  it("survives non-string file fields", () => {
    const raw = JSON.stringify({
      hunks: [{ op: "create", file: 42, content: "hi" }],
    });
    const s = summarizeAgentResponse(raw);
    assert.ok(s);
    if (s!.kind !== "worker_hunks") assert.fail();
    assert.equal(s!.firstFile, undefined);
  });
});
