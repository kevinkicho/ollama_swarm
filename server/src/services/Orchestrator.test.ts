// Tests for the #293 known-parents discovery helpers — exported from
// Orchestrator.ts so the on-disk fallback (when /tmp persistence is
// missing or truncated) can be verified without spinning up a full
// orchestrator + agent manager + repos chain.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeKnownParents, scanForRunParents } from "./Orchestrator.js";

describe("mergeKnownParents", () => {
  it("dedupes entries, preserving persisted order", () => {
    const out = mergeKnownParents(["/a", "/b", "/c"], ["/c", "/d"]);
    assert.deepEqual(out, ["/a", "/b", "/c", "/d"]);
  });

  it("treats persisted as the recency source of truth", () => {
    const out = mergeKnownParents(["/c", "/b"], ["/a", "/b", "/c"]);
    assert.deepEqual(out, ["/c", "/b", "/a"]);
  });

  it("returns empty when both inputs empty", () => {
    assert.deepEqual(mergeKnownParents([], []), []);
  });

  it("respects KNOWN_PARENTS_MAX (32)", () => {
    const persisted = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const scanned = Array.from({ length: 40 }, (_, i) => `/s${i}`);
    const out = mergeKnownParents(persisted, scanned);
    assert.equal(out.length, 32);
    // First 32 entries are the persisted prefix.
    assert.equal(out[0], "/p0");
    assert.equal(out[31], "/p31");
  });

  it("dedup is case-sensitive (paths are byte-equal)", () => {
    const out = mergeKnownParents(["/Foo"], ["/foo"]);
    assert.deepEqual(out, ["/Foo", "/foo"]);
  });
});

describe("scanForRunParents — discovers runs/* + runs_overnight*/* roots", () => {
  function setupFixture(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), "scan-runs-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  it("finds a runs/<clone>/summary.json root", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "runs", "my-clone"), { recursive: true });
      writeFileSync(join(cwd, "runs", "my-clone", "summary.json"), "{}");
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "runs")]);
    } finally {
      cleanup();
    }
  });

  it("finds runs_overnight*/<clone>/summary-<iso>.json (per-run files)", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "runs_overnight9", "alpha"), { recursive: true });
      writeFileSync(
        join(cwd, "runs_overnight9", "alpha", "summary-2026-04-28T01-00-00-000Z.json"),
        "{}",
      );
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "runs_overnight9")]);
    } finally {
      cleanup();
    }
  });

  it("returns multiple roots when several exist", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "runs", "a"), { recursive: true });
      writeFileSync(join(cwd, "runs", "a", "summary.json"), "{}");
      mkdirSync(join(cwd, "runs_overnight", "b"), { recursive: true });
      writeFileSync(join(cwd, "runs_overnight", "b", "summary.json"), "{}");
      mkdirSync(join(cwd, "runs_overnight2", "c"), { recursive: true });
      writeFileSync(join(cwd, "runs_overnight2", "c", "summary-x.json"), "{}");
      const out = new Set(scanForRunParents(cwd));
      assert.equal(out.size, 3);
      assert.ok(out.has(join(cwd, "runs")));
      assert.ok(out.has(join(cwd, "runs_overnight")));
      assert.ok(out.has(join(cwd, "runs_overnight2")));
    } finally {
      cleanup();
    }
  });

  it("skips dirs without any summary file", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "runs", "empty-clone"), { recursive: true });
      // No summary file dropped in.
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, []);
    } finally {
      cleanup();
    }
  });

  it("skips top-level dirs that don't match runs / runs_*", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "src", "anything"), { recursive: true });
      writeFileSync(join(cwd, "src", "anything", "summary.json"), "{}");
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, []);
    } finally {
      cleanup();
    }
  });

  it("returns [] for an unreadable / nonexistent cwd", () => {
    const out = scanForRunParents("/no/such/dir/anywhere");
    assert.deepEqual(out, []);
  });

  it("doesn't double-count one root that has multiple clones with summaries", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "runs", "a"), { recursive: true });
      writeFileSync(join(cwd, "runs", "a", "summary.json"), "{}");
      mkdirSync(join(cwd, "runs", "b"), { recursive: true });
      writeFileSync(join(cwd, "runs", "b", "summary-1.json"), "{}");
      mkdirSync(join(cwd, "runs", "c"), { recursive: true });
      writeFileSync(join(cwd, "runs", "c", "summary.json"), "{}");
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "runs")]);
    } finally {
      cleanup();
    }
  });
});
