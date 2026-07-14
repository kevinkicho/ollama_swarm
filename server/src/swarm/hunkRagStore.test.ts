import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendHunkExample,
  readHunkExamples,
  serializeHunksForRag,
  isValidPastHunkExample,
  HUNK_RAG_FILENAME,
} from "./hunkRagStore.js";

describe("hunkRagStore", () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hunk-rag-"));
  });

  after(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("serializeHunksForRag produces JSON envelope", () => {
    const s = serializeHunksForRag([
      { op: "replace", file: "a.ts", search: "x", replace: "y" },
    ]);
    assert.match(s, /"hunks"/);
    assert.match(s, /a\.ts/);
  });

  it("isValidPastHunkExample rejects empty", () => {
    assert.equal(isValidPastHunkExample({}), false);
    assert.equal(
      isValidPastHunkExample({
        todoDescription: "fix",
        expectedFiles: ["a.ts"],
        hunkResponse: '{"hunks":[]}',
      }),
      true,
    );
  });

  it("append + read round-trip", async () => {
    await appendHunkExample(dir, {
      todoDescription: "Add null guard",
      expectedFiles: ["src/util.ts"],
      hunkResponse: '{"hunks":[{"op":"replace","file":"src/util.ts"}]}',
      runId: "r1",
    });
    const all = await readHunkExamples(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.todoDescription, "Add null guard");
    assert.deepEqual(all[0]!.expectedFiles, ["src/util.ts"]);

    const file = path.join(dir, HUNK_RAG_FILENAME);
    const st = await fs.stat(file);
    assert.ok(st.size > 0);
  });
});
