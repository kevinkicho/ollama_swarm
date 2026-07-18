import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerResponse } from "./blackboard/prompts/worker.js";
import { repairAndParseJson } from "./repairJson.js";
import { parseWorkerResponseWithRepair } from "./councilWorkerAttempt.js";
import { normalizeRepoPath } from "./blackboard/prompts/worker.js";

describe("live-run parse probes (4de10651)", () => {
  it("fenced json hunks parse", () => {
    const raw =
      '```json\n{"hunks":[{"op":"replace","file":"a.ts","search":"o","replace":"n"}]}\n```';
    const r = parseWorkerResponseWithRepair(raw, ["a.ts"]);
    assert.equal(r.ok, true, !r.ok ? r.reason : "");
  });

  it("bare key after [ soft-repairs", () => {
    const raw = '{"hunks":[op":"replace","file":"a.ts","search":"o","replace":"n"]}';
    const soft = repairAndParseJson(raw);
    assert.ok(soft, "soft repair should succeed");
    const r = parseWorkerResponseWithRepair(raw, ["a.ts"]);
    assert.equal(r.ok, true, !r.ok ? r.reason : "");
  });

  it("normalizeRepoPath strips leading slash", () => {
    assert.equal(normalizeRepoPath("/24_loop_quantum_gravity.html"), "24_loop_quantum_gravity.html");
  });
});

describe("tool aliases (36632e9e)", () => {
  it("canonicalizeToolName maps str_replace_editor → edit", async () => {
    const { canonicalizeToolName } = await import("../tools/ToolDispatcher.js");
    assert.equal(canonicalizeToolName("str_replace_editor"), "edit");
    assert.equal(canonicalizeToolName("StrReplaceEditor"), "edit");
    assert.equal(canonicalizeToolName("shell"), "run");
    assert.equal(canonicalizeToolName("write"), "write");
  });
});
