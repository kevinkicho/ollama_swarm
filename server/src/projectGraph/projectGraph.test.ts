import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFromSummaries } from "./buildFromSummaries.js";
import { mergeRunIntoGraph } from "./mergeSidecar.js";
import { computeAnchorOverlap } from "./anchorOverlap.js";
import { formatAgentSlice } from "./formatAgentSlice.js";
import { parseGitLogRaw } from "./gitHistory.js";
import { moduleKeyForFile, extractRelativeImports, resolveRelativeImport } from "./structureScan.js";
import { analyzeProjectGraphForBrain } from "./graphLibrarian.js";

describe("buildFromSummaries", () => {
  it("builds run and file nodes with edges", () => {
    const g = buildFromSummaries("/ws/proj", [
      {
        runId: "abc12345",
        preset: "blackboard",
        startedAt: 1000,
        endedAt: 2000,
        stopReason: "completed",
        deliverables: [
          { path: "src/foo.ts", status: "modified" },
          { path: "docs/plan.md", status: "created" },
        ],
      },
      {
        runId: "def67890",
        preset: "blackboard",
        startedAt: 3000,
        deliverables: [{ path: "src/foo.ts", status: "modified" }],
      },
    ]);

    assert.equal(g.stats.runCount, 2);
    assert.equal(g.stats.fileCount, 2);
    assert.ok(g.nodes.some((n) => n.kind === "run" && n.runId === "abc12345"));
    assert.ok(g.nodes.some((n) => n.kind === "file" && n.path === "src/foo.ts"));
    assert.ok(g.edges.some((e) => e.kind === "modified" && e.to === "file:src/foo.ts"));
    assert.equal(g.anchors.hotFiles[0]?.path, "src/foo.ts");
    assert.equal(g.anchors.hotFiles[0]?.runCount, 2);
  });
});

describe("mergeRunIntoGraph", () => {
  it("merges a new run into existing sidecar graph", () => {
    const first = buildFromSummaries("/ws/proj", [
      {
        runId: "run-one",
        startedAt: 1,
        deliverables: [{ path: "a.ts", status: "created" }],
      },
    ]);
    const merged = mergeRunIntoGraph(first, "/ws/proj", {
      runId: "run-two",
      startedAt: 2,
      deliverables: [{ path: "b.ts", status: "modified" }],
    });
    assert.equal(merged.stats.runCount, 2);
    assert.ok(merged.nodes.some((n) => n.runId === "run-two"));
  });
});

describe("computeAnchorOverlap", () => {
  it("flags off-graph paths", () => {
    const r = computeAnchorOverlap(
      ["src/unrelated.ts", "README.md"],
      { missionFiles: ["README.md"], hotFiles: [{ path: "src/foo.ts", runCount: 2 }] },
    );
    assert.equal(r.anchorOverlap, 50);
    assert.deepEqual(r.offGraphPaths, ["src/unrelated.ts"]);
    assert.equal(r.recoverySuggested, false);
  });

  it("suggests recovery when mostly off-graph", () => {
    const r = computeAnchorOverlap(
      ["x.ts", "y.ts", "z.ts"],
      { missionFiles: [], hotFiles: [{ path: "src/foo.ts", runCount: 1 }] },
    );
    assert.equal(r.anchorOverlap, 0);
    assert.equal(r.recoverySuggested, true);
  });
});

describe("parseGitLogRaw", () => {
  it("parses commit blocks with shortstat", () => {
    const raw = `@@abc123def456|fix bug|Alice|2026-07-08T12:00:00+00:00

 2 files changed, 10 insertions(+), 3 deletions(-)
@@fed654cba321|docs|Bob|2026-07-07T10:00:00+00:00`;
    const commits = parseGitLogRaw(raw);
    assert.equal(commits.length, 2);
    assert.equal(commits[0]?.hash, "abc123def456");
    assert.equal(commits[0]?.filesChanged, 2);
    assert.equal(commits[0]?.insertions, 10);
  });
});

describe("structureScan helpers", () => {
  it("moduleKeyForFile buckets by top two segments", () => {
    assert.equal(moduleKeyForFile("server/src/foo.ts"), "server/src");
    assert.equal(moduleKeyForFile("README.md"), "README.md");
  });

  it("extracts relative imports", () => {
    const imports = extractRelativeImports('import x from "./foo";\nconst y = require("../bar");');
    assert.deepEqual(imports.sort(), ["../bar", "./foo"]);
  });

  it("resolves relative import paths", () => {
    assert.equal(resolveRelativeImport("server/src/a.ts", "./b"), "server/src/b");
  });
});

describe("analyzeProjectGraphForBrain", () => {
  it("surfaces over-touched files and scope suggestions", () => {
    const g = buildFromSummaries("/ws/proj", [
      { runId: "r1", startedAt: 1, deliverables: [{ path: "src/hot.ts", status: "modified" }] },
      { runId: "r2", startedAt: 2, deliverables: [{ path: "src/hot.ts", status: "modified" }] },
      { runId: "r3", startedAt: 3, deliverables: [{ path: "src/hot.ts", status: "modified" }] },
    ]);
    g.structureLayer = {
      updatedAt: 1,
      scannedFiles: 10,
      modules: [{ path: "web/src", fileCount: 8 }, { path: "server/src", fileCount: 5 }],
      edges: [],
    };
    const insights = analyzeProjectGraphForBrain(g);
    assert.ok(insights.overTouchedFiles.some((f) => f.path === "src/hot.ts"));
    assert.ok(insights.summaryLines.length > 0);
  });
});

describe("formatAgentSlice", () => {
  it("includes hot files and caps length", () => {
    const g = buildFromSummaries("/ws/proj", [
      {
        runId: "abc",
        startedAt: 1,
        deliverables: [{ path: "src/foo.ts", status: "modified" }],
      },
    ]);
    const slice = formatAgentSlice(g, { maxChars: 500 });
    assert.match(slice, /Project map/);
    assert.match(slice, /src\/foo\.ts/);
    assert.ok(slice.length <= 500);
  });
});