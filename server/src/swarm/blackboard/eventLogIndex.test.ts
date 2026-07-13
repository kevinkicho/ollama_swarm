import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendArchiveIndexHits,
  loadArchiveIndexHits,
  loadEventLogIndex,
  paginateLoggedRecords,
  saveEventLogIndex,
  upsertIndexEntry,
  entryFromIndex,
} from "./eventLogIndex.js";

describe("paginateLoggedRecords", () => {
  const recs = Array.from({ length: 10 }, (_, i) => ({ ts: (i + 1) * 1000, n: i }));

  it("returns last limit records for first page", () => {
    const page = paginateLoggedRecords(recs, { limit: 3 });
    assert.equal(page.records.length, 3);
    assert.equal(page.records[0]!.ts, 8000);
    assert.equal(page.records[2]!.ts, 10_000);
    assert.equal(page.hasMoreOlder, true);
    assert.equal(page.total, 10);
  });

  it("loads older page with beforeTs", () => {
    const page = paginateLoggedRecords(recs, { limit: 3, beforeTs: 8000 });
    assert.equal(page.records.length, 3);
    assert.equal(page.records[0]!.ts, 5000);
    assert.equal(page.records[2]!.ts, 7000);
    assert.equal(page.hasMoreOlder, true);
  });

  it("no more older at start", () => {
    const page = paginateLoggedRecords(recs, { limit: 5, beforeTs: 4000 });
    assert.equal(page.records[0]!.ts, 1000);
    assert.equal(page.hasMoreOlder, false);
  });
});

describe("event-log-index.json", () => {
  it("round-trips per-run rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-idx-"));
    try {
      const index = await loadEventLogIndex(dir);
      upsertIndexEntry(index, {
        runId: "r1",
        bytes: 100,
        mtimeMs: 12345,
        lineCount: 9,
        derived: null,
      });
      await saveEventLogIndex(dir, index);
      const loaded = await loadEventLogIndex(dir);
      assert.ok(loaded.perRun.r1);
      assert.equal(loaded.perRun.r1!.lineCount, 9);
      const entry = entryFromIndex(loaded.perRun.r1!);
      assert.equal(entry.runId, "r1");
      assert.equal(entry.fromMeta, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("archives-index.jsonl", () => {
  it("appends and loads hits by runId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-arch-"));
    try {
      await appendArchiveIndexHits(dir, [
        {
          archive: "events-1.jsonl.gz",
          runId: "run-a",
          startedAt: 1000,
          preset: "council",
        },
      ]);
      await appendArchiveIndexHits(dir, [
        {
          archive: "events-2.jsonl.gz",
          runId: "run-a",
          startedAt: 2000,
          preset: "blackboard",
        },
      ]);
      const map = await loadArchiveIndexHits(dir);
      const hit = map.get("run-a");
      assert.ok(hit);
      // last write wins
      assert.equal(hit!.archive, "events-2.jsonl.gz");
      assert.equal(hit!.preset, "blackboard");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
