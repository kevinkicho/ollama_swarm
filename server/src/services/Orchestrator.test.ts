// Tests for the #293 known-parents discovery helpers — exported from
// Orchestrator.ts so the on-disk fallback (when /tmp persistence is
// missing or truncated) can be verified without spinning up a full
// orchestrator + agent manager + repos chain.

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeKnownParents, scanForRunParents } from "./Orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SRC = readFileSync(join(__dirname, "Orchestrator.ts"), "utf8");

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

describe("scanForRunParents — discovers logs/{runId}/ directories with summary files", () => {
  function setupFixture(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), "scan-runs-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  it("finds a logs/{runId}/summary.json directory", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs", "abc123"), { recursive: true });
      writeFileSync(join(cwd, "logs", "abc123", "summary.json"), "{}");
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "logs", "abc123")]);
    } finally {
      cleanup();
    }
  });

  it("finds logs/{runId}/summary-<iso>.json (per-run files)", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs", "def456"), { recursive: true });
      writeFileSync(
        join(cwd, "logs", "def456", "summary-2026-04-28T01-00-00-000Z.json"),
        "{}",
      );
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "logs", "def456")]);
    } finally {
      cleanup();
    }
  });

  it("returns multiple run directories when several exist", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs", "run1"), { recursive: true });
      writeFileSync(join(cwd, "logs", "run1", "summary.json"), "{}");
      mkdirSync(join(cwd, "logs", "run2"), { recursive: true });
      writeFileSync(join(cwd, "logs", "run2", "summary.json"), "{}");
      mkdirSync(join(cwd, "logs", "run3"), { recursive: true });
      writeFileSync(join(cwd, "logs", "run3", "summary-x.json"), "{}");
      const out = new Set(scanForRunParents(cwd));
      assert.equal(out.size, 3);
      assert.ok(out.has(join(cwd, "logs", "run1")));
      assert.ok(out.has(join(cwd, "logs", "run2")));
      assert.ok(out.has(join(cwd, "logs", "run3")));
    } finally {
      cleanup();
    }
  });

  it("skips dirs without any summary file", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs", "empty-run"), { recursive: true });
      // No summary file dropped in.
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, []);
    } finally {
      cleanup();
    }
  });

  it("skips non-directory entries in logs/", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      writeFileSync(join(cwd, "logs", "stray-file.txt"), "not a run");
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

  it("doesn't double-count one run directory with multiple summary files", () => {
    const { cwd, cleanup } = setupFixture();
    try {
      mkdirSync(join(cwd, "logs", "run1"), { recursive: true });
      writeFileSync(join(cwd, "logs", "run1", "summary.json"), "{}");
      writeFileSync(join(cwd, "logs", "run1", "summary-1.json"), "{}");
      writeFileSync(join(cwd, "logs", "run1", "summary-2.json"), "{}");
      const out = scanForRunParents(cwd);
      assert.deepEqual(out, [join(cwd, "logs", "run1")]);
    } finally {
      cleanup();
    }
  });
});

// 2026-05-01 (#119): structural — Orchestrator.injectUser must dual-write
// to BOTH the runner's transcript AND the AmendmentsBuffer so blackboard's
// directiveWithAmendments() picks up chat as a mid-run nudge. Pre-fix:
// only the runner.injectUser was called; chat went to display only for
// blackboard (which doesn't surface user-role transcript entries in
// prompts) and MoA (same gap). The 7 other discussion runners use the
// [HUMAN] formatter on the transcript path so they were unaffected.

test("Orchestrator: cleanupStaleRuns reaps terminal runs without runner.stop()", () => {
  assert.match(
    ORCHESTRATOR_SRC,
    /if \(run\.isRunning\(\)\) continue;\s*const phase = run\.runner\.status/,
    "skip active runs — do not stop booting idle-phase runs",
  );
  assert.match(
    ORCHESTRATOR_SRC,
    /if \(!terminal\) continue;[\s\S]*?teardown\(\{\s*stopRunner:\s*false/,
    "terminal cleanup must not call runner.stop() — that marks user-stopped",
  );
});

test("Orchestrator: stopRunsOnClonePath scopes force-restart to one clone", () => {
  assert.match(ORCHESTRATOR_SRC, /async stopRunsOnClonePath\(localPath: string\)/);
  assert.match(
    ORCHESTRATOR_SRC,
    /stopRunsOnClonePath[\s\S]*?nodePath\.resolve\(run\.cfg\.localPath\) !== target/,
  );
});

test("Orchestrator: WorkspaceBusyError for same-clone concurrent start", () => {
  assert.match(ORCHESTRATOR_SRC, /export class WorkspaceBusyError/);
  assert.match(ORCHESTRATOR_SRC, /throw new WorkspaceBusyError\(otherId/);
});

test("Orchestrator.injectUser — dual-writes to runner.transcript AND amendments buffer", () => {
  // 2026-05-02 (chat lever #2): signature now accepts an optional opts
  // param with intent + targetAgent. Default intent === "steer" preserves
  // the pre-tagged amendments-dual-write behavior.
  assert.match(
    ORCHESTRATOR_SRC,
    /injectUser\(\s*text: string,\s*opts\?:[\s\S]*?this\.runner\?\.injectUser\(text, opts\)/,
    "must still call runner.injectUser with opts so per-runner code sees the tag",
  );
  // The amendments-side dual-write now ALSO gates on intent==="steer"
  // so suggest/ask don't burn a planner reshape unnecessarily.
  assert.match(
    ORCHESTRATOR_SRC,
    /this\.amendments\.add\(this\.runId, text\)/,
    "must ALSO call amendments.add so blackboard sees chat as a planner nudge",
  );
  assert.match(
    ORCHESTRATOR_SRC,
    /if \(this\.runId && text\.trim\(\)\.length > 0 && intent === "steer"\)/,
    "amendments dual-write must be gated on (runId AND non-empty text AND intent==='steer')",
  );
});
