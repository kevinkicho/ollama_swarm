// T2.1 + T2.2 (2026-05-04): tests for the shared wrap-up apply phase.
// The full runWrapUpApplyPhase exercises a real provider call + git
// commit which needs a stub harness — pulled into a separate
// integration suite. This file covers the pure parts: readTopNextAction
// (parses the next-actions.json sibling and picks the highest-priority
// action) + WrapUpApplyResult shape contracts.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSynthesizerMissRepromptBlock,
  readTopNextAction,
} from "./wrapUpApplyPhase.js";
import type { ApplyMissReport } from "./blackboard/applyMissReport.js";

describe("readTopNextAction — parser", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "wrap-up-apply-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns null when no next-actions JSON exists for the preset/runId", async () => {
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "12345678-no-match",
      presetName: "council",
    });
    assert.equal(top, null);
  });

  it("returns null when clonePath doesn't exist", async () => {
    const top = await readTopNextAction({
      clonePath: join(workdir, "doesnt-exist"),
      runId: "anyrun",
      presetName: "moa",
    });
    assert.equal(top, null);
  });

  it("picks the high-priority action over medium and low", async () => {
    const filename = "next-actions-council-12345678-2026-05-04.json";
    writeFileSync(
      join(workdir, filename),
      JSON.stringify({
        preset: "council",
        runId: "12345678-runid",
        generatedAt: "2026-05-04T00:00:00Z",
        schemaVersion: 1,
        actions: [
          { priority: "low", text: "Investigate logging" },
          { priority: "high", text: "Fix the race in worker pool" },
          { priority: "medium", text: "Refactor the auth module" },
        ],
      }),
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "12345678-runid",
      presetName: "council",
    });
    assert.equal(top, "Fix the race in worker pool");
  });

  it("picks the newest file when multiple JSON snapshots exist for same runId", async () => {
    writeFileSync(
      join(workdir, "next-actions-moa-12345678-2026-05-04T10-00-00-000Z.json"),
      JSON.stringify({
        actions: [{ priority: "high", text: "older action" }],
      }),
      "utf8",
    );
    writeFileSync(
      join(workdir, "next-actions-moa-12345678-2026-05-04T11-00-00-000Z.json"),
      JSON.stringify({
        actions: [{ priority: "high", text: "newer action" }],
      }),
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "12345678-runid",
      presetName: "moa",
    });
    assert.equal(top, "newer action");
  });

  it("returns null when the JSON's actions array is empty", async () => {
    writeFileSync(
      join(workdir, "next-actions-stigmergy-abc12345-2026-05-04.json"),
      JSON.stringify({ actions: [] }),
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "abc12345-runid",
      presetName: "stigmergy",
    });
    assert.equal(top, null);
  });

  it("returns null when the JSON is malformed (best-effort)", async () => {
    writeFileSync(
      join(workdir, "next-actions-debate-judge-zzz99999-2026-05-04.json"),
      "{not valid json",
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "zzz99999-runid",
      presetName: "debate-judge",
    });
    assert.equal(top, null);
  });

  it("returns null when actions item lacks text", async () => {
    writeFileSync(
      join(workdir, "next-actions-mapreduce-deadbeef-2026-05-04.json"),
      JSON.stringify({
        actions: [{ priority: "high" }, { priority: "medium", text: "" }],
      }),
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "deadbeef-runid",
      presetName: "mapreduce",
    });
    assert.equal(top, null);
  });

  it("filters by preset name — won't pick another preset's actions for the same runId", async () => {
    // Council ran first and wrote its file.
    writeFileSync(
      join(workdir, "next-actions-council-12345678-2026-05-04.json"),
      JSON.stringify({
        actions: [{ priority: "high", text: "council recommendation" }],
      }),
      "utf8",
    );
    // We're asking for moa's file with the same runId — should miss.
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "12345678-runid",
      presetName: "moa",
    });
    assert.equal(top, null);
  });

  it("treats unknown priority as 0 — high still wins", async () => {
    writeFileSync(
      join(workdir, "next-actions-ow-aaaaaaaa-2026-05-04.json"),
      JSON.stringify({
        actions: [
          { priority: "supercritical", text: "unknown-prio item" },
          { priority: "high", text: "high-prio item" },
        ],
      }),
      "utf8",
    );
    const top = await readTopNextAction({
      clonePath: workdir,
      runId: "aaaaaaaa-runid",
      presetName: "ow",
    });
    assert.equal(top, "high-prio item");
  });
});

describe("buildSynthesizerMissRepromptBlock — grounded fallthrough", () => {
  it("includes reasons, nearbyExcerpt, and uniqueCandidates", () => {
    const miss: ApplyMissReport = {
      file: "marketPanels.js",
      hunkIndex: 0,
      op: "replace",
      kind: "search_not_found",
      needle: "stale anchor",
      matchCount: 0,
      nearbyExcerpt: "live disk nearby TEXT",
      uniqueCandidates: ["exact candidate from file"],
      message: "search not found",
    };
    const block = buildSynthesizerMissRepromptBlock(
      ['marketPanels.js: hunk[0] op "replace": "search" text not found in file'],
      [miss],
    );
    assert.ok(block.includes("PRIOR ATTEMPT FAILED"));
    assert.ok(block.includes("marketPanels.js"));
    assert.ok(block.includes("kind=search_not_found"));
    assert.ok(block.includes("live disk nearby TEXT"));
    assert.ok(block.includes("exact candidate from file"));
    assert.ok(block.includes("uniqueCandidates"));
    assert.ok(block.includes("Do not invent anchors"));
  });
});
