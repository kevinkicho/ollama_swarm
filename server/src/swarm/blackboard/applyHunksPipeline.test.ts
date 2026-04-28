import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHunks } from "./applyHunks.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { parseWorkerResponse } from "./prompts/worker.js";

// End-to-end pipeline test: raw worker JSON → parseWorkerResponse →
// applyHunks → writeFileAtomic, against a real tmp directory.
//
// Unit tests cover each module in isolation; this test proves the glue
// between them works. Specifically, it checks:
//   - hunks parsed from JSON flow into applyHunks without shape drift
//   - applyHunks output keys match the shape writeFileAtomic consumes
//   - on any failure in the chain, nothing gets written to disk (atomicity)

async function mktmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "worker-pipeline-"));
}

async function readExpected(
  dir: string,
  files: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of files) {
    try {
      out[f] = await fs.readFile(path.join(dir, f), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        out[f] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

async function writeStarting(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [f, content] of Object.entries(files)) {
    await writeFileAtomic(path.join(dir, f), content);
  }
}

// Run the full pipeline for a given raw response. Returns the final disk
// state of the expected files, or an error string if any step failed.
async function runPipeline(
  dir: string,
  rawResponse: string,
  expectedFiles: string[],
): Promise<{ ok: true; disk: Record<string, string | null> } | { ok: false; error: string; disk: Record<string, string | null> }> {
  const parsed = parseWorkerResponse(rawResponse, expectedFiles);
  if (!parsed.ok) {
    return { ok: false, error: `parse: ${parsed.reason}`, disk: await readExpected(dir, expectedFiles) };
  }
  const contents = await readExpected(dir, expectedFiles);
  const applied = applyHunks(contents, parsed.hunks);
  if (!applied.ok) {
    return { ok: false, error: `apply: ${applied.error}`, disk: contents };
  }
  // Write each resulting file. If this throws we propagate.
  for (const [f, text] of Object.entries(applied.newTextsByFile)) {
    await writeFileAtomic(path.join(dir, f), text);
  }
  return { ok: true, disk: await readExpected(dir, expectedFiles) };
}

describe("worker pipeline — happy paths", () => {
  it("applies a single replace hunk to disk", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "README.md": "# Old Title\n\nHello.\n" });
      const raw = JSON.stringify({
        hunks: [
          { op: "replace", file: "README.md", search: "# Old Title", replace: "# New Title" },
        ],
      });
      const r = await runPipeline(dir, raw, ["README.md"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["README.md"], "# New Title\n\nHello.\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a brand-new file from a create hunk", async () => {
    const dir = await mktmp();
    try {
      const raw = JSON.stringify({
        hunks: [
          { op: "create", file: "docs/NEW.md", content: "# New Doc\n" },
        ],
      });
      // Must mkdir the parent because writeFileAtomic writes directly via
      // tmp+rename and the runner pre-creates parents via fs.mkdir recursive.
      // Skip that concern here: only test a file at the top level.
      const rawTop = JSON.stringify({
        hunks: [
          { op: "create", file: "NEW.md", content: "# New Doc\n" },
        ],
      });
      const r = await runPipeline(dir, rawTop, ["NEW.md"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["NEW.md"], "# New Doc\n");
      // Silence unused var warning from commented-out nested-dir case.
      void raw;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appends to an existing file", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "CHANGELOG.md": "# Changelog\n" });
      const raw = JSON.stringify({
        hunks: [
          { op: "append", file: "CHANGELOG.md", content: "\n## 0.2\n- new thing\n" },
        ],
      });
      const r = await runPipeline(dir, raw, ["CHANGELOG.md"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["CHANGELOG.md"], "# Changelog\n\n## 0.2\n- new thing\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("applies two hunks against the same file sequentially", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, {
        "src.ts": "const foo = 1;\nconst bar = 2;\n",
      });
      const raw = JSON.stringify({
        hunks: [
          { op: "replace", file: "src.ts", search: "const foo = 1;", replace: "const foo = 10;" },
          { op: "replace", file: "src.ts", search: "const bar = 2;", replace: "const bar = 20;" },
        ],
      });
      const r = await runPipeline(dir, raw, ["src.ts"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["src.ts"], "const foo = 10;\nconst bar = 20;\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("touches multiple files in one batch and leaves untouched files alone", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, {
        "a.md": "A old\n",
        "b.md": "B old\n",
        "c.md": "C untouched\n",
      });
      const raw = JSON.stringify({
        hunks: [
          { op: "replace", file: "a.md", search: "A old", replace: "A new" },
          { op: "replace", file: "b.md", search: "B old", replace: "B new" },
        ],
      });
      const r = await runPipeline(dir, raw, ["a.md", "b.md"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["a.md"], "A new\n");
      assert.equal(r.disk["b.md"], "B new\n");
      // c.md wasn't in expectedFiles — confirm it's unchanged on disk.
      const c = await fs.readFile(path.join(dir, "c.md"), "utf8");
      assert.equal(c, "C untouched\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("handles fenced JSON responses the way a sloppy worker might emit", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "a.md": "hello\n" });
      const raw =
        '```json\n{"hunks":[{"op":"replace","file":"a.md","search":"hello","replace":"goodbye"}]}\n```';
      const r = await runPipeline(dir, raw, ["a.md"]);
      assert.equal(r.ok, true);
      assert.equal(r.disk["a.md"], "goodbye\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("worker pipeline — failure modes leave disk untouched", () => {
  it("malformed JSON never reaches disk", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "a.md": "original\n" });
      const r = await runPipeline(dir, "{not valid json", ["a.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /parse/);
      assert.equal(r.disk["a.md"], "original\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ambiguous replace anchor (multiple matches) leaves files untouched", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "a.md": "foo bar foo baz foo\n" });
      const raw = JSON.stringify({
        hunks: [{ op: "replace", file: "a.md", search: "foo", replace: "X" }],
      });
      const r = await runPipeline(dir, raw, ["a.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /apply:.*matches 3 times/);
      assert.equal(r.disk["a.md"], "foo bar foo baz foo\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("replace anchor not found leaves files untouched", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "a.md": "hello\n" });
      const raw = JSON.stringify({
        hunks: [{ op: "replace", file: "a.md", search: "nope", replace: "X" }],
      });
      const r = await runPipeline(dir, raw, ["a.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /apply:.*not found/);
      assert.equal(r.disk["a.md"], "hello\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("create hunk on an existing file fails and does not overwrite it", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "a.md": "precious original\n" });
      const raw = JSON.stringify({
        hunks: [{ op: "create", file: "a.md", content: "replacement attempt\n" }],
      });
      const r = await runPipeline(dir, raw, ["a.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /apply:.*file already exists/);
      assert.equal(r.disk["a.md"], "precious original\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a later hunk failing rolls back the batch — first file's writes do not happen", async () => {
    // This is the atomicity guarantee across a multi-hunk response. The
    // first replace succeeds in applyHunks but the second fails; since
    // applyHunks returns an error for the whole batch, no writes occur.
    const dir = await mktmp();
    try {
      await writeStarting(dir, {
        "a.md": "stage1\n",
        "b.md": "untouched B\n",
      });
      const raw = JSON.stringify({
        hunks: [
          { op: "replace", file: "a.md", search: "stage1", replace: "stage2" },
          // Second hunk targets a.md for text that now exists only in the
          // applied version. But we also throw in a broken b.md hunk so the
          // batch fails — this proves nothing on disk moves.
          { op: "replace", file: "b.md", search: "MISSING", replace: "nope" },
        ],
      });
      const r = await runPipeline(dir, raw, ["a.md", "b.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /apply:/);
      assert.equal(r.disk["a.md"], "stage1\n");
      assert.equal(r.disk["b.md"], "untouched B\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hunk targeting a file outside expectedFiles is rejected at parse time", async () => {
    const dir = await mktmp();
    try {
      await writeStarting(dir, { "allowed.md": "A\n", "forbidden.md": "F\n" });
      const raw = JSON.stringify({
        hunks: [
          { op: "replace", file: "forbidden.md", search: "F", replace: "X" },
        ],
      });
      const r = await runPipeline(dir, raw, ["allowed.md"]);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.error, /parse:.*not in expectedFiles/);
      const forbidden = await fs.readFile(path.join(dir, "forbidden.md"), "utf8");
      assert.equal(forbidden, "F\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
