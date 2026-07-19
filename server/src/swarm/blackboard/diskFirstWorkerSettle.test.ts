import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pathsFromSuccessfulMutateTools,
  pickDiskFirstFiles,
  synthesizeWorkingTreeParse,
} from "./diskFirstWorkerSettle.js";
import type { ToolTraceEntry } from "../toolCallTranscript.js";

describe("diskFirstWorkerSettle", () => {
  it("extracts paths from successful write/edit previews", () => {
    const trace: ToolTraceEntry[] = [
      { tool: "read", ok: true, preview: "src/a.ts → export const a", ts: 1 },
      { tool: "write", ok: true, preview: "src/panels/Foo.tsx → wrote 1200 chars", ts: 2 },
      { tool: "edit", ok: false, preview: "src/b.ts → ERROR", ts: 3 },
      { tool: "edit", ok: true, preview: "src/panels/Foo.tsx → patched", ts: 4 },
    ];
    assert.deepEqual(pathsFromSuccessfulMutateTools(trace), ["src/panels/Foo.tsx"]);
  });

  it("pickDiskFirstFiles prefers expected intersection", () => {
    const files = pickDiskFirstFiles(
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts", "src/other.ts"],
      [],
    );
    assert.deepEqual(files, ["src/a.ts"]);
  });

  it("synthesizeWorkingTreeParse builds ok envelope", () => {
    const p = synthesizeWorkingTreeParse(["src/a.ts"], "fix a");
    assert.ok(p);
    assert.equal(p!.ok, true);
    assert.equal(p!.workingTree, true);
    assert.deepEqual(p!.filesTouched, ["src/a.ts"]);
    assert.equal(p!.hunks.length, 0);
  });

  it("synthesizeWorkingTreeParse rejects empty files", () => {
    assert.equal(synthesizeWorkingTreeParse([], "x"), null);
  });

  it("pickDiskFirstFiles falls back to tools when expected miss", () => {
    const files = pickDiskFirstFiles(["src/expected.ts"], ["src/actual.ts"], []);
    assert.deepEqual(files, ["src/actual.ts"]);
  });

  it("pickDiskFirstFiles uses dirty when tools empty", () => {
    const files = pickDiskFirstFiles(["src/a.ts"], [], ["src/a.ts", "src/noise.ts"]);
    assert.deepEqual(files, ["src/a.ts"]);
  });

  it("pathsFromSuccessfulMutateTools ignores failed and non-mutate tools", () => {
    const trace: ToolTraceEntry[] = [
      { tool: "bash", ok: true, preview: "echo hi", ts: 1 },
      { tool: "write", ok: false, preview: "x.ts → fail", ts: 2 },
    ];
    assert.deepEqual(pathsFromSuccessfulMutateTools(trace), []);
  });
});
