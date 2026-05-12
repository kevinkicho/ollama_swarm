import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { OTEngine } from "./OTEngine.js";
import type { HunkOp } from "./OTEngine.js";

function op(
  overrides: Partial<HunkOp> & { id: string; agentId: string; file: string; type: HunkOp["type"]; anchor: string; content: string },
): HunkOp {
  return {
    timestamp: Date.now(),
    baseRevision: 0,
    ...overrides,
  };
}

describe("OTEngine — initFile and basic state", () => {
  let engine: OTEngine;

  beforeEach(() => {
    engine = new OTEngine();
  });

  it("initializes a file with content and revision 0", () => {
    engine.initFile("src/foo.ts", "hello");
    assert.equal(engine.getContent("src/foo.ts"), "hello");
    assert.equal(engine.getRevision("src/foo.ts"), 0);
  });

  it("does not overwrite an already-initialized file", () => {
    engine.initFile("src/foo.ts", "first");
    engine.initFile("src/foo.ts", "second");
    assert.equal(engine.getContent("src/foo.ts"), "first");
  });

  it("returns empty string for untracked file", () => {
    assert.equal(engine.getContent("nonexistent.ts"), "");
  });

  it("returns revision 0 for untracked file", () => {
    assert.equal(engine.getRevision("nonexistent.ts"), 0);
  });
});

describe("OTEngine — replace operations", () => {
  let engine: OTEngine;

  beforeEach(() => {
    engine = new OTEngine();
    engine.initFile("src/foo.ts", "hello world");
  });

  it("applies a replace op at the current revision", () => {
    const replaceOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "replace",
      anchor: "hello",
      content: "goodbye",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(replaceOp);
    assert.equal(result.accepted, true);
    assert.equal(result.conflict, undefined);
    assert.equal(engine.getContent("src/foo.ts"), "goodbye world");
    assert.equal(engine.getRevision("src/foo.ts"), 1);
  });

  it("rejects a replace op with a missing anchor", () => {
    const replaceOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "replace",
      anchor: "nonexistent",
      content: "replacement",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(replaceOp);
    assert.equal(result.accepted, false);
    assert.ok(result.conflict);
  });

  it("replaces full content when anchor is empty string", () => {
    const replaceOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "replace",
      anchor: "",
      content: "entirely new content",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(replaceOp);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("src/foo.ts"), "entirely new content");
  });
});

describe("OTEngine — insert operations", () => {
  let engine: OTEngine;

  beforeEach(() => {
    engine = new OTEngine();
    engine.initFile("src/foo.ts", "hello world");
  });

  it("inserts content before anchor position", () => {
    const insertOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "insert",
      anchor: "hello",
      content: "beautiful ",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(insertOp);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("src/foo.ts"), "beautiful hello world");
  });

  it("inserts at beginning when anchor is empty", () => {
    const insertOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "insert",
      anchor: "",
      content: "prefix ",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(insertOp);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("src/foo.ts"), "prefix hello world");
  });
});

describe("OTEngine — delete operations", () => {
  let engine: OTEngine;

  beforeEach(() => {
    engine = new OTEngine();
    engine.initFile("src/foo.ts", "hello world");
  });

  it("deletes the anchor text", () => {
    const deleteOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "delete",
      anchor: "hello ",
      content: "",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(deleteOp);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("src/foo.ts"), "world");
  });

  it("rejects delete for missing anchor", () => {
    const deleteOp: HunkOp = {
      id: "op1",
      agentId: "agent-1",
      file: "src/foo.ts",
      type: "delete",
      anchor: "nonexistent",
      content: "",
      timestamp: Date.now(),
      baseRevision: 0,
    };
    const result = engine.applyOp(deleteOp);
    assert.equal(result.accepted, false);
  });
});

describe("OTEngine — concurrent operations at different positions", () => {
  it("applies two non-overlapping edits sequentially", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "AAA BBB CCC");

    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "replace", anchor: "AAA", content: "DDD",
      timestamp: Date.now(), baseRevision: 0,
    };
    engine.applyOp(op1);
    assert.equal(engine.getContent("src/foo.ts"), "DDD BBB CCC");
    assert.equal(engine.getRevision("src/foo.ts"), 1);

    const op2: HunkOp = {
      id: "op2", agentId: "a2", file: "src/foo.ts",
      type: "replace", anchor: "CCC", content: "EEE",
      timestamp: Date.now(), baseRevision: 1,
    };
    engine.applyOp(op2);
    assert.equal(engine.getContent("src/foo.ts"), "DDD BBB EEE");
    assert.equal(engine.getRevision("src/foo.ts"), 2);
  });
});

describe("OTEngine — operations on nonexistent files", () => {
  it("auto-creates file for replace op", () => {
    const engine = new OTEngine();
    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "new.ts",
      type: "replace", anchor: "", content: "new file",
      timestamp: Date.now(), baseRevision: 0,
    };
    const result = engine.applyOp(op1);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("new.ts"), "new file");
  });

  it("auto-creates file for insert op", () => {
    const engine = new OTEngine();
    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "new.ts",
      type: "insert", anchor: "", content: "inserted",
      timestamp: Date.now(), baseRevision: 0,
    };
    const result = engine.applyOp(op1);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("new.ts"), "inserted");
  });

  it("rejects delete on nonexistent file", () => {
    const engine = new OTEngine();
    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "missing.ts",
      type: "delete", anchor: "text", content: "",
      timestamp: Date.now(), baseRevision: 0,
    };
    const result = engine.applyOp(op1);
    assert.equal(result.accepted, false);
    assert.ok(result.conflict);
  });
});

describe("OTEngine — applyOps batch", () => {
  it("applies a batch of operations and returns merge result", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "original");

    const ops: HunkOp[] = [
      { id: "op1", agentId: "a1", file: "src/foo.ts", type: "replace", anchor: "original", content: "replaced", timestamp: Date.now(), baseRevision: 0 },
    ];

    const result = engine.applyOps(ops);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.resultingRevision, 1);
    assert.equal(result.fileContents["src/foo.ts"], "replaced");
  });

  it("mixes accepted and rejected ops", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "abc def");

    const ops: HunkOp[] = [
      { id: "op1", agentId: "a1", file: "src/foo.ts", type: "replace", anchor: "abc", content: "xyz", timestamp: Date.now(), baseRevision: 0 },
      { id: "op2", agentId: "a2", file: "src/foo.ts", type: "replace", anchor: "abc", content: "uvw", timestamp: Date.now(), baseRevision: 0 },
    ];

    const result = engine.applyOps(ops);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.conflicts.length >= 1);
  });
});

describe("OTEngine — same anchor conflict (last-writer-wins for same revision)", () => {
  it("first writer wins at same revision, second gets conflict", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "content");

    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "replace", anchor: "content", content: "first",
      timestamp: Date.now(), baseRevision: 0,
    };
    const op2: HunkOp = {
      id: "op2", agentId: "a2", file: "src/foo.ts",
      type: "replace", anchor: "content", content: "second",
      timestamp: Date.now(), baseRevision: 0,
    };

    const r1 = engine.applyOp(op1);
    assert.equal(r1.accepted, true);

    const r2 = engine.applyOp(op2);
    assert.equal(r2.accepted, false);
    assert.equal(engine.getContent("src/foo.ts"), "first");
  });
});

describe("OTEngine — delete after insert at same position", () => {
  it("inserts then replaces overlapping text", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "hello world");

    const insertOp: HunkOp = {
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "insert", anchor: "", content: "PREFIX ",
      timestamp: Date.now(), baseRevision: 0,
    };
    engine.applyOp(insertOp);
    assert.equal(engine.getContent("src/foo.ts"), "PREFIX hello world");

    const replaceOp: HunkOp = {
      id: "op2", agentId: "a2", file: "src/foo.ts",
      type: "replace", anchor: "hello", content: "goodbye",
      timestamp: Date.now(), baseRevision: 1,
    };
    engine.applyOp(replaceOp);
    assert.equal(engine.getContent("src/foo.ts"), "PREFIX goodbye world");
  });
});

describe("OTEngine — transform of operations with different base versions", () => {
  it("transforms an op against intervening ops", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "AAA BBB CCC");

    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "replace", anchor: "AAA", content: "DDD",
      timestamp: Date.now(), baseRevision: 0,
    };
    engine.applyOp(op1);
    assert.equal(engine.getContent("src/foo.ts"), "DDD BBB CCC");

    const op2: HunkOp = {
      id: "op2", agentId: "a2", file: "src/foo.ts",
      type: "replace", anchor: "CCC", content: "EEE",
      timestamp: Date.now(), baseRevision: 0,
    };
    const result = engine.applyOp(op2);
    assert.equal(result.accepted, true);
    assert.equal(engine.getContent("src/foo.ts"), "DDD BBB EEE");
  });
});

describe("OTEngine — idempotency", () => {
  it("applying same op twice is rejected on second attempt", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "original");

    const op1: HunkOp = {
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "replace", anchor: "original", content: "replaced",
      timestamp: Date.now(), baseRevision: 0,
    };
    const r1 = engine.applyOp(op1);
    assert.equal(r1.accepted, true);

    const r2 = engine.applyOp(op1);
    assert.equal(r2.accepted, false);
  });
});

describe("OTEngine — snapshot and reset", () => {
  it("returns file snapshot with content and revision", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "content");
    engine.applyOp({
      id: "op1", agentId: "a1", file: "src/foo.ts",
      type: "replace", anchor: "content", content: "new",
      timestamp: Date.now(), baseRevision: 0,
    });

    const snap = engine.snapshot();
    assert.equal(snap["src/foo.ts"].content, "new");
    assert.equal(snap["src/foo.ts"].revision, 1);
  });

  it("reset clears all files", () => {
    const engine = new OTEngine();
    engine.initFile("src/foo.ts", "content");
    engine.reset();
    assert.equal(engine.getContent("src/foo.ts"), "");
    assert.equal(engine.getRevision("src/foo.ts"), 0);
  });
});