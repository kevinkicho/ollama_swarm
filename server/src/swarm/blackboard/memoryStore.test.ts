import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEMORY_FILENAME,
  MEMORY_FILE_BUDGET_BYTES,
  MEMORY_MAX_LESSONS_PER_ENTRY,
  appendMemoryEntry,
  isValidMemoryEntry,
  memoryFilePath,
  parseMemoryLessons,
  readMemory,
  readRecentMemory,
  renderMemoryForSeed,
  type MemoryEntry,
} from "./memoryStore.js";

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    ts: 1_000_000,
    runId: "abcdefab-1234",
    tier: 1,
    commits: 3,
    lessons: ["always X", "never Y"],
    ...over,
  };
}

async function mkTmpClone(label: string): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `swarm-mem-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("isValidMemoryEntry — schema guard", () => {
  it("accepts a well-formed entry", () => {
    assert.equal(isValidMemoryEntry(entry()), true);
  });

  it("rejects non-object inputs", () => {
    assert.equal(isValidMemoryEntry(null), false);
    assert.equal(isValidMemoryEntry(undefined), false);
    assert.equal(isValidMemoryEntry("string"), false);
    assert.equal(isValidMemoryEntry(42), false);
  });

  it("rejects when required fields are missing or wrong-typed", () => {
    assert.equal(isValidMemoryEntry({ ...entry(), ts: "yesterday" }), false);
    assert.equal(isValidMemoryEntry({ ...entry(), runId: "" }), false);
    assert.equal(isValidMemoryEntry({ ...entry(), tier: -1 }), false);
    assert.equal(isValidMemoryEntry({ ...entry(), commits: 1.5 }), false);
    assert.equal(isValidMemoryEntry({ ...entry(), lessons: [] }), false);
    assert.equal(isValidMemoryEntry({ ...entry(), lessons: ["", "  "] }), false);
  });

  it("rejects when lessons exceed the schema cap", () => {
    const tooMany = Array.from({ length: MEMORY_MAX_LESSONS_PER_ENTRY + 1 }, (_, i) => `l${i}`);
    assert.equal(isValidMemoryEntry({ ...entry(), lessons: tooMany }), false);
  });
});

describe("readMemory + appendMemoryEntry — file I/O", () => {
  it("returns [] when the file doesn't exist", async () => {
    const dir = await mkTmpClone("empty");
    try {
      const out = await readMemory(dir);
      assert.deepEqual(out, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appends entries one per line and reads them back in insertion order", async () => {
    const dir = await mkTmpClone("append");
    try {
      const a = entry({ ts: 1, runId: "first", lessons: ["a"] });
      const b = entry({ ts: 2, runId: "second", lessons: ["b"] });
      await appendMemoryEntry(dir, a);
      await appendMemoryEntry(dir, b);
      const out = await readMemory(dir);
      assert.equal(out.length, 2);
      assert.equal(out[0]!.runId, "first");
      assert.equal(out[1]!.runId, "second");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("memoryFilePath uses the documented filename", async () => {
    assert.equal(path.basename(memoryFilePath("/some/clone")), MEMORY_FILENAME);
  });

  it("skips malformed lines silently when reading", async () => {
    const dir = await mkTmpClone("malformed");
    try {
      const file = memoryFilePath(dir);
      const valid = JSON.stringify(entry({ runId: "ok" }));
      await fs.writeFile(
        file,
        [valid, "not-json", "{}", JSON.stringify(entry({ runId: "ok2" }))].join("\n"),
        "utf8",
      );
      const out = await readMemory(dir);
      assert.equal(out.length, 2);
      assert.deepEqual(
        out.map((e) => e.runId),
        ["ok", "ok2"],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects appendMemoryEntry on schema-invalid input", async () => {
    const dir = await mkTmpClone("badappend");
    try {
      await assert.rejects(
        async () => appendMemoryEntry(dir, { ...entry(), lessons: [] } as MemoryEntry),
        /schema validation/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("trims and rewrites when an append would exceed the budget", async () => {
    const dir = await mkTmpClone("trim");
    try {
      // Pre-fill the file just past the byte budget so the next append
      // triggers the rewrite branch.
      const fat = "x".repeat(2_000);
      const fatLessons = [fat, fat, fat]; // ~6kb per entry serialized
      const file = memoryFilePath(dir);
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        // 200 fat entries → ~1.2 MB, comfortably over the 1 MB budget.
        lines.push(JSON.stringify(entry({ ts: 1_000 + i, runId: `r${i}`, lessons: fatLessons })));
      }
      await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
      const before = (await fs.stat(file)).size;
      assert.ok(before > MEMORY_FILE_BUDGET_BYTES, "fixture should exceed budget");

      // Trigger trim with a small new entry.
      const newEntry = entry({ ts: 9_999, runId: "fresh", lessons: ["small"] });
      await appendMemoryEntry(dir, newEntry);

      const after = (await fs.stat(file)).size;
      assert.ok(after < before, "trim should shrink the file");
      const all = await readMemory(dir);
      assert.ok(all.length < 200, "should have dropped older entries");
      assert.equal(all[all.length - 1]!.runId, "fresh", "new entry should be last");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readRecentMemory — ordering + count", () => {
  it("returns most-recent-first, capped to count", async () => {
    const dir = await mkTmpClone("recent");
    try {
      for (const ts of [10, 50, 30, 70, 20]) {
        await appendMemoryEntry(dir, entry({ ts, runId: `r${ts}`, lessons: ["x"] }));
      }
      const out = await readRecentMemory(dir, 3);
      assert.deepEqual(
        out.map((e) => e.ts),
        [70, 50, 30],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderMemoryForSeed", () => {
  it("returns empty string on empty input", () => {
    assert.equal(renderMemoryForSeed([]), "");
  });

  it("renders a header + per-entry bullet block + footer guidance", () => {
    const out = renderMemoryForSeed([
      entry({ ts: Date.parse("2026-04-25T10:00:00Z"), runId: "abcdefab", tier: 2, commits: 5, lessons: ["L1", "L2"] }),
    ]);
    assert.match(out, /Prior runs on this clone/i);
    assert.match(out, /tier 2/);
    assert.match(out, /5 commits/);
    assert.match(out, /· L1/);
    assert.match(out, /· L2/);
    // Footer must instruct the planner to use, not slavishly follow.
    assert.match(out, /Don't slavishly follow/i);
  });
});

describe("parseMemoryLessons — distillation response parsing", () => {
  it("parses a clean JSON object with a lessons array", () => {
    const out = parseMemoryLessons('{"lessons": ["foo", "bar"]}');
    assert.deepEqual(out, ["foo", "bar"]);
  });

  it("strips ```json fences", () => {
    const out = parseMemoryLessons('```json\n{"lessons": ["fenced"]}\n```');
    assert.deepEqual(out, ["fenced"]);
  });

  it("tolerates prose preamble before the JSON object", () => {
    const out = parseMemoryLessons(
      'Here are the lessons:\n{"lessons": ["sliced"]}',
    );
    assert.deepEqual(out, ["sliced"]);
  });

  it("returns [] on unparseable input (caller treats as 'nothing memorable')", () => {
    assert.deepEqual(parseMemoryLessons("not json at all"), []);
    assert.deepEqual(parseMemoryLessons(""), []);
    assert.deepEqual(parseMemoryLessons("[]"), []);
  });

  it("returns [] when lessons is missing or wrong-typed", () => {
    assert.deepEqual(parseMemoryLessons('{"lessons": "string-not-array"}'), []);
    assert.deepEqual(parseMemoryLessons('{}'), []);
    assert.deepEqual(parseMemoryLessons('{"other": ["x"]}'), []);
  });

  it("trims whitespace and drops empty entries", () => {
    const out = parseMemoryLessons('{"lessons": ["  keep  ", "", "   "]}');
    assert.deepEqual(out, ["keep"]);
  });

  it("caps output at MEMORY_MAX_LESSONS_PER_ENTRY entries", () => {
    const lots = Array.from({ length: MEMORY_MAX_LESSONS_PER_ENTRY + 5 }, (_, i) => `l${i}`);
    const out = parseMemoryLessons(JSON.stringify({ lessons: lots }));
    assert.equal(out.length, MEMORY_MAX_LESSONS_PER_ENTRY);
  });

  it("ignores non-string entries inside the array", () => {
    const out = parseMemoryLessons(
      JSON.stringify({ lessons: ["ok", 42, null, { nested: 1 }, "ok2"] }),
    );
    assert.deepEqual(out, ["ok", "ok2"]);
  });
});
