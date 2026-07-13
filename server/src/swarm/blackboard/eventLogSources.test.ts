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
  writeDebugMetaSidecar,
  tryReadDebugMetaSidecar,
  indexPerRunDebugLogs,
  listRotatedDebugSegments,
  readPerRunDebugLog,
} from "./eventLogSources.js";
import zlib from "node:zlib";

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

describe("debug.meta.json sidecar", () => {
  it("prefer fresh meta over re-scanning debug.jsonl", async () => {
    clearEventLogListCache();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-meta-"));
    try {
      const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const runDir = path.join(dir, runId);
      await fs.mkdir(runDir, { recursive: true });
      const debugPath = path.join(runDir, "debug.jsonl");
      await fs.writeFile(
        debugPath,
        JSON.stringify({ ts: 1, event: { type: "run_started", runId, preset: "council" } }) + "\n",
        "utf8",
      );
      const st = await fs.stat(debugPath);
      await writeDebugMetaSidecar(dir, {
        runId,
        bytes: st.size,
        lineCount: 42,
        derived: {
          runId,
          preset: "council",
          startedAt: 1000,
          finishedAt: 5000,
          durationMs: 4000,
          hasSummary: true,
          stopReason: "completed",
          errors: [],
          transcriptCount: 3,
          agentStateUpdates: 0,
          agentActivityEvents: 0,
          activityTimeline: [],
          phaseTimeline: [],
          eventTypeCounts: {},
          modelShiftCount: 0,
          brainFallbackCount: 0,
          todoClaimed: 0,
          todoFailed: 0,
          todoReplanned: 0,
          todoSkipped: 0,
          streamingEventCount: 0,
          streamingEndCount: 0,
          amendmentCount: 0,
          conformanceSampleCount: 0,
          driftSampleCount: 0,
          coldStartCount: 0,
          streamAnomalies: [],
          anomalyFlags: [],
        },
      });
      // Ensure meta mtime is not older than debug (Windows fs rounding).
      const metaPath = path.join(runDir, "debug.meta.json");
      const metaExists = await fs.stat(metaPath).catch(() => null);
      assert.ok(metaExists, "debug.meta.json must exist after writeDebugMetaSidecar");
      const future = new Date(Date.now() + 5_000);
      await fs.utimes(metaPath, future, future);

      const fromMeta = await tryReadDebugMetaSidecar(dir, runId, st.mtimeMs, st.size);
      assert.ok(fromMeta, "tryReadDebugMetaSidecar should accept fresh meta");
      assert.equal(fromMeta!.fromMeta, true);
      assert.equal(fromMeta!.lineCount, 42);
      assert.equal(fromMeta!.derived?.stopReason, "completed");

      const indexed = await indexPerRunDebugLogs(dir);
      const row = indexed.find((r) => r.runId === runId);
      assert.ok(row);
      assert.equal(row!.fromMeta, true);
      assert.equal(row!.lineCount, 42);
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

describe("rotated debug merge (PR4)", () => {
  it("lists rotated segments and merges them into replay", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evt-rot-"));
    try {
      const runId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      const runDir = path.join(dir, runId);
      await fs.mkdir(runDir, { recursive: true });
      const oldLine =
        JSON.stringify({
          ts: 1_000,
          event: { type: "run_started", runId, preset: "blackboard" },
        }) + "\n";
      const midLine =
        JSON.stringify({
          ts: 2_000,
          event: { type: "transcript_append", role: "system", text: "mid" },
        }) + "\n";
      const curLine =
        JSON.stringify({
          ts: 3_000,
          event: { type: "run_summary", summary: { stopReason: "completed" } },
        }) + "\n";
      await fs.writeFile(
        path.join(runDir, "debug-2026-01-01T00-00-00-000Z.jsonl.gz"),
        zlib.gzipSync(Buffer.from(oldLine + midLine, "utf8")),
      );
      await fs.writeFile(path.join(runDir, "debug.jsonl"), curLine, "utf8");

      const segs = await listRotatedDebugSegments(runDir);
      assert.equal(segs.length, 1);

      const replay = await readPerRunDebugLog(dir, runId);
      assert.ok(replay);
      assert.ok(replay!.records.length >= 2);
      const types = replay!.records.map((r) => (r.event as { type?: string }).type);
      assert.ok(types.includes("run_started"));
      assert.ok(types.includes("run_summary"));
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