import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import {
  readAllEventLogs,
  buildEventLogRunList,
  findRunReplay,
  clearEventLogListCache,
  PER_RUN_INDEX_FULL_READ_MAX_BYTES,
} from "./eventLogSources.js";

describe("readAllEventLogs", () => {
  it("reads rotated .jsonl.gz archives before current.jsonl", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-log-src-"));
    try {
      const archiveLine =
        JSON.stringify({ ts: 1, event: { type: "run_started", runId: "old-run", preset: "council" } }) +
        "\n";
      const gzName = "events-2026-07-08T10-00-00-000Z.jsonl.gz";
      await fs.writeFile(
        path.join(dir, gzName),
        zlib.gzipSync(Buffer.from(archiveLine, "utf8")),
      );
      const currentLine =
        JSON.stringify({ ts: 2, event: { type: "run_started", runId: "new-run", preset: "blackboard" } }) +
        "\n";
      await fs.writeFile(path.join(dir, "current.jsonl"), currentLine, "utf8");

      const result = await readAllEventLogs(path.join(dir, "current.jsonl"));
      assert.equal(result.records.length, 2);
      assert.equal(result.records[0].event.runId, "old-run");
      assert.equal(result.records[1].event.runId, "new-run");
      assert.equal(result.archivesTotal, 1);
      assert.equal(result.archivesRead, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEventLogRunList", () => {
  it("lists per-run debug folders and current tail", async () => {
    clearEventLogListCache();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-list-"));
    try {
      const runId = "11111111-2222-4333-8444-555555555555";
      const runDir = path.join(dir, runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "debug.jsonl"),
        [
          JSON.stringify({ ts: 5_000, event: { type: "run_started", runId, preset: "council" } }),
          JSON.stringify({ ts: 65_000, event: { type: "run_summary", summary: { stopReason: "completed" } } }),
        ].join("\n") + "\n",
        "utf8",
      );
      const tail =
        JSON.stringify({ ts: 9, event: { type: "run_started", runId: "live-run", preset: "blackboard" } }) +
        "\n";
      const tailPath = path.join(dir, "current.jsonl");
      await fs.writeFile(tailPath, tail, "utf8");

      const list = await buildEventLogRunList(tailPath, dir);
      const ids = list.runs.map((r) => r.derived.runId).filter(Boolean);
      assert.ok(ids.includes(runId));
      assert.ok(ids.includes("live-run"));
      const archived = list.runs.find((r) => r.derived.runId === runId);
      assert.ok(archived);
      assert.equal(archived!.source, "per-run-debug");
      assert.equal(archived!.derived.durationMs, 60_000);
      assert.equal(archived!.derived.transcriptCount, 0);
      assert.equal(archived!.derived.hasSummary, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("indexes large per-run debug logs without full-file JSON parse", async () => {
    clearEventLogListCache();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-list-large-"));
    try {
      const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const runDir = path.join(dir, runId);
      await fs.mkdir(runDir, { recursive: true });
      const debugPath = path.join(runDir, "debug.jsonl");

      const head =
        JSON.stringify({ ts: 1_000, event: { type: "run_started", runId, preset: "council" } }) + "\n";
      const tail =
        JSON.stringify({ ts: 9_000, event: { type: "run_summary", summary: { stopReason: "completed" } } }) +
        "\n";
      const fillerLine =
        JSON.stringify({ ts: 5_000, event: { type: "transcript_append", agentId: "agent-1" } }) + "\n";
      const fillerBytes = PER_RUN_INDEX_FULL_READ_MAX_BYTES + 512 * 1024;
      const fillerCount = Math.ceil(fillerBytes / fillerLine.length);
      await fs.writeFile(debugPath, head + fillerLine.repeat(fillerCount) + tail, "utf8");

      const stat = await fs.stat(debugPath);
      assert.ok(stat.size > PER_RUN_INDEX_FULL_READ_MAX_BYTES);

      const list = await buildEventLogRunList(path.join(dir, "current.jsonl"), dir);
      const archived = list.runs.find((r) => r.derived.runId === runId);
      assert.ok(archived, "expected large debug run in list");
      assert.equal(archived!.source, "per-run-debug");
      assert.equal(archived!.derived.preset, "council");
      assert.equal(archived!.derived.hasSummary, true);
      assert.equal(archived!.derived.durationMs, 8_000);
      assert.equal(archived!.derived.transcriptCount, fillerCount);
      assert.equal(archived!.recordCount, fillerCount + 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findRunReplay", () => {
  it("finds a run slice in the tail log file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-replay-"));
    try {
      const sampleLog = [
        JSON.stringify({ ts: 1000, event: { type: "_session_started" } }),
        JSON.stringify({ ts: 1100, event: { type: "run_started", runId: "r1", preset: "blackboard" } }),
        JSON.stringify({ ts: 1200, event: { type: "transcript_append" } }),
        JSON.stringify({ ts: 1500, event: { type: "run_started", runId: "r2", preset: "council" } }),
        JSON.stringify({ ts: 1600, event: { type: "transcript_append" } }),
      ].join("\n");
      const logPath = path.join(dir, "test.jsonl");
      await fs.writeFile(logPath, sampleLog, "utf8");
      const replay = await findRunReplay(dir, logPath, "r2");
      assert.ok(replay);
      assert.equal(replay!.source, "global");
      assert.equal(replay!.slice.records.length, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});