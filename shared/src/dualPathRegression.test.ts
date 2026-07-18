/**
 * Dual-path regression fixtures for blackboard (926054b0) + council (2010479c).
 *
 * Shared modules must keep both presets green:
 *  - soft JSON repair + worker hunks (BB repair thrash / UI raw hunks)
 *  - replan emit-first policy (agent-1 replan tool thrash)
 *  - tool profile emit-only + replan explore caps
 *
 * Live runs are still the gold standard; these lock the invariants that
 * failed open in production without spinning an LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonCandidate, parseJsonEnvelope } from "./parseAgentJson.js";
import { tryParseWithSoftRepairs, stripJsonFences } from "./softJsonRepair.js";
import { tryParseWorkerHunks } from "./workerHunks.js";
import {
  resolveReplanPolicy,
  classifyStaleReason,
} from "./replanPolicy.js";
import {
  EMIT_ONLY_PROFILE_ID,
  EXPLORE_MAX_REPLAN_TOOL_TURNS,
  DISCUSSION_DRAFT_JSON_NUDGE_TURN,
  resolveMaxToolTurnsForPlanningPhase,
} from "./toolProfiles.js";

/** Live 83dc5910 shape: fence + missing `{` before bare key after `[`. */
const LIVE_83DC_BARE_KEY =
  '```json\n{"hunks":[op":"replace","file":"src/App.tsx","search":"a","replace":"b"]}\n```';

/** Live-ish 926054b0 shape: unclosed fence + smart quotes. */
const LIVE_9260_UNCLOSED = `\`\`\`json
{"hunks":[{"op":"create","file":"README.md","content":"hi"}]}`;

/** 2010479c: replace_between with JSON null endExclusive. */
const LIVE_2010_REPLACE_BETWEEN = JSON.stringify({
  hunks: [
    {
      op: "replace_between",
      file: "src/page.tsx",
      start: "function Page() {",
      endExclusive: null,
      replace: "function Page() {\n  return null;\n}",
    },
  ],
});

describe("dual-path — soft repair (BB + council shared)", () => {
  it("repairs bare-key fence blob (83dc5910)", () => {
    const soft = tryParseWithSoftRepairs(LIVE_83DC_BARE_KEY);
    assert.ok(soft, "soft repair must succeed");
    const env = parseJsonEnvelope(LIVE_83DC_BARE_KEY);
    assert.equal(env.ok, true);
  });

  it("accepts unclosed json fence (926054b0 thrash shape)", () => {
    const unfenced = stripJsonFences(LIVE_9260_UNCLOSED);
    assert.ok(unfenced.includes('"hunks"'));
    const cand = extractJsonCandidate(LIVE_9260_UNCLOSED);
    assert.ok(cand, "extractJsonCandidate must salvage unclosed fence");
  });

  it("tryParseWorkerHunks handles replace_between null endExclusive (2010479c)", () => {
    const hunks = tryParseWorkerHunks(LIVE_2010_REPLACE_BETWEEN);
    assert.ok(hunks);
    assert.equal(hunks!.length, 1);
    assert.equal(hunks![0]!.op, "replace_between");
    assert.equal(hunks![0]!.file, "src/page.tsx");
    assert.equal(hunks![0]!.endExclusive, undefined);
  });
});

describe("dual-path — replan emit-bias (926054b0 agent-1)", () => {
  it("emitFirst for worker timeout and tool-cap with tight explore budget", () => {
    const timeout = resolveReplanPolicy("prompt wall-clock exceeded 120000ms");
    assert.equal(timeout.emitFirst, true);
    assert.equal(timeout.maxToolTurns, EXPLORE_MAX_REPLAN_TOOL_TURNS);
    assert.equal(EXPLORE_MAX_REPLAN_TOOL_TURNS, 6);

    const toolCap = resolveReplanPolicy("Ollama tool loop exceeded 35 turns");
    assert.equal(toolCap.emitFirst, true);
    assert.equal(toolCap.maxToolTurns, 6);
  });

  it("zeros explore tools under batch breaker / exploration cache", () => {
    const batch = resolveReplanPolicy("wall-clock exceeded", { batchBreaker: true });
    assert.equal(batch.emitFirst, true);
    assert.equal(batch.maxToolTurns, 0);
    assert.equal(batch.allowExplore, false);

    const cached = resolveReplanPolicy("unknown reason", { hasExplorationCache: true });
    assert.equal(cached.emitFirst, true);
    assert.equal(cached.maxToolTurns, 0);
  });

  it("CAS/hunk-fail still emit-first with small explore budget", () => {
    assert.equal(classifyStaleReason("CAS mismatch on t2"), "cas-drift");
    const p = resolveReplanPolicy("hunk apply failed: search not unique");
    assert.equal(p.emitFirst, true);
    assert.equal(p.maxToolTurns, 4);
  });

  it("planning-phase replan tool budget matches EXPLORE_MAX_REPLAN_TOOL_TURNS", () => {
    const n = resolveMaxToolTurnsForPlanningPhase("replan", {});
    assert.equal(n, EXPLORE_MAX_REPLAN_TOOL_TURNS);
  });
});

describe("dual-path — emit-only + discussion nudge (shared profiles)", () => {
  it("EMIT_ONLY_PROFILE_ID is tools-off swarm profile", () => {
    assert.equal(EMIT_ONLY_PROFILE_ID, "swarm");
  });

  it("discussion draft JSON nudge fires early enough to unstick incomplete drafts", () => {
    // 2010479c: drafts stuck in tool loop — nudge was 40, now 12.
    assert.ok(
      DISCUSSION_DRAFT_JSON_NUDGE_TURN <= 15,
      `nudge turn ${DISCUSSION_DRAFT_JSON_NUDGE_TURN} should be ≤15`,
    );
  });
});
