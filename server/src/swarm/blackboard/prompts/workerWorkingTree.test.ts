import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerResponse, WORKER_SYSTEM_PROMPT } from "./worker.js";

describe("parseWorkerResponse workingTree + soft expectedFiles", () => {
  it("parses workingTree envelope without requiring hunks", () => {
    const raw = JSON.stringify({
      workingTree: true,
      message: "add helper",
      files: ["src/helper.ts"],
    });
    const r = parseWorkerResponse(raw, ["src/helper.ts"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.workingTree, true);
      assert.equal(r.gitMessage, "add helper");
      assert.deepEqual(r.filesTouched, ["src/helper.ts"]);
      assert.equal(r.hunks.length, 0);
    }
  });

  it("parses mode:git alias", () => {
    const raw = JSON.stringify({
      mode: "git",
      files: ["a.ts"],
      message: "m",
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.workingTree, true);
  });

  it("soft-accepts same-directory file outside exact expectedFiles", () => {
    // Without SWARM_STRICT_EXPECTED_FILES, same-dir paths are allowed.
    const prev = process.env.SWARM_STRICT_EXPECTED_FILES;
    delete process.env.SWARM_STRICT_EXPECTED_FILES;
    try {
      const raw = JSON.stringify({
        hunks: [
          {
            op: "write",
            file: "src/panels/NewPanel.tsx",
            content: "export default function NewPanel() { return null; }\n",
          },
        ],
      });
      const r = parseWorkerResponse(raw, ["src/panels/panelRegistry.ts"]);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.hunks.length, 1);
        assert.equal((r.hunks[0] as { file: string }).file, "src/panels/NewPanel.tsx");
      }
    } finally {
      if (prev !== undefined) process.env.SWARM_STRICT_EXPECTED_FILES = prev;
      else delete process.env.SWARM_STRICT_EXPECTED_FILES;
    }
  });

  it("WORKER_SYSTEM_PROMPT prefers git-native workingTree", () => {
    assert.match(WORKER_SYSTEM_PROMPT, /workingTree/);
    assert.match(WORKER_SYSTEM_PROMPT, /write\/edit/);
    assert.match(WORKER_SYSTEM_PROMPT, /git_status|disk changes/i);
  });
});
