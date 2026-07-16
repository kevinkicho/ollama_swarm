// Behavioral tests for grounded hunk-repair dry-run accept/reject gate.
// Source-shape asserts for emit-only repair live in BlackboardRunner.hunkRepair.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptRepairedHunksIfApply } from "./workerSelfConsistency.js";
import type { Hunk } from "./applyHunks.js";
import { defaultToolsForProfile } from "../../tools/ToolDispatcher.js";
import { EMIT_ONLY_PROFILE_ID } from "@ollama-swarm/shared/toolProfiles";

describe("acceptRepairedHunksIfApply — dry-run gate", () => {
  const original: Hunk[] = [
    { op: "replace", file: "a.ts", search: "MISSING_ANCHOR", replace: "new" },
  ];
  const contents = { "a.ts": "hello world\n" };

  it("accepts repaired hunks when they apply cleanly", () => {
    const repaired: Hunk[] = [
      { op: "replace", file: "a.ts", search: "hello world\n", replace: "hello fixed\n" },
    ];
    const r = acceptRepairedHunksIfApply(original, repaired, contents);
    assert.equal(r.accepted, true);
    assert.deepEqual(r.hunks, repaired);
    assert.equal(r.error, undefined);
  });

  it("rejects repaired hunks that still miss and keeps originals", () => {
    const repaired: Hunk[] = [
      { op: "replace", file: "a.ts", search: "STILL_WRONG", replace: "nope" },
    ];
    const r = acceptRepairedHunksIfApply(original, repaired, contents);
    assert.equal(r.accepted, false);
    assert.deepEqual(r.hunks, original);
    assert.ok(r.error && /search|not found/i.test(r.error));
  });

  it("rejects empty repaired list", () => {
    const r = acceptRepairedHunksIfApply(original, [], contents);
    assert.equal(r.accepted, false);
    assert.deepEqual(r.hunks, original);
  });
});

describe("EMIT_ONLY_PROFILE_ID — tools-off for pure apply repair", () => {
  it("advertises zero tools (literature/web cannot run)", () => {
    assert.equal(EMIT_ONLY_PROFILE_ID, "swarm");
    assert.deepEqual([...defaultToolsForProfile("swarm")], []);
  });
});
