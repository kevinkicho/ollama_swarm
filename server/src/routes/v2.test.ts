// V2 Step 6b tests: /api/v2/event-log/runs handler.
//
// Tests against an in-memory tmp file rather than mocking fs — the
// route is so thin it's not worth a full express test rig. Just
// hit the handler directly with a mock req/res.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { v2Router } from "./v2.js";

interface MockResponse {
  statusCode: number;
  body: unknown;
}

function makeRes(): { res: import("express").Response; mock: MockResponse } {
  const mock: MockResponse = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      mock.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      mock.body = payload;
      return this;
    },
  } as unknown as import("express").Response;
  return { res, mock };
}

async function withTempLog(
  contents: string,
  fn: (logPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-route-test-"));
  const logPath = path.join(dir, "test.jsonl");
  await fs.writeFile(logPath, contents, "utf8");
  try {
    await fn(logPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function getRunsHandler(router: import("express").Router): (
  req: import("express").Request,
  res: import("express").Response,
) => Promise<void> {
  // Express stores routes on router.stack — extract the handler for
  // GET /event-log/runs by matching the path string + method.
  const stack = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }> }).stack;
  for (const layer of stack) {
    if (layer.route?.path === "/event-log/runs" && layer.route.methods.get) {
      return layer.route.stack[0].handle as (
        req: import("express").Request,
        res: import("express").Response,
      ) => Promise<void>;
    }
  }
  throw new Error("could not find handler for GET /event-log/runs");
}

describe("v2Router /status", () => {
  it("reports flag state from process.env", async () => {
    const router = v2Router({ eventLogPath: "/tmp/test.jsonl" });
    // Find /status handler
    const stack = (router as unknown as { stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
    }> }).stack;
    type Handler = (req: import("express").Request, res: import("express").Response) => unknown;
    let handler: Handler | null = null;
    for (const layer of stack) {
      if (layer.route?.path === "/status" && layer.route.methods.get) {
        handler = layer.route.stack[0].handle as Handler;
        break;
      }
    }
    if (!handler) throw new Error("could not find /status handler");
    const { res, mock } = makeRes();
    handler({} as import("express").Request, res);
    const body = mock.body as { flags: Record<string, boolean>; v2Substrates: Record<string, string> };
    assert.equal(typeof body.flags.USE_OLLAMA_DIRECT, "boolean");
    assert.equal(typeof body.flags.USE_WORKER_PIPELINE_V2, "boolean");
    assert.ok(body.v2Substrates.todoQueueV2);
    assert.ok(body.v2Substrates.workerPipelineV2);
  });
});

describe("v2Router /event-log/runs", () => {
  it("returns empty runs when log doesn't exist (ENOENT)", async () => {
    const router = v2Router({ eventLogPath: "/nonexistent/path/log.jsonl" });
    const handler = getRunsHandler(router);
    const { res, mock } = makeRes();
    await handler({} as import("express").Request, res);
    assert.equal(mock.statusCode, 200);
    const body = mock.body as { runs: unknown[]; malformed: number };
    assert.equal(body.runs.length, 0);
    assert.equal(body.malformed, 0);
  });

  it("parses + slices a real log file", async () => {
    const jsonl = [
      JSON.stringify({ ts: 1000, event: { type: "_session_started" } }),
      JSON.stringify({ ts: 1100, event: { type: "run_started", runId: "r1", preset: "blackboard" } }),
      JSON.stringify({ ts: 1200, event: { type: "transcript_append" } }),
      JSON.stringify({ ts: 1300, event: { type: "swarm_state", phase: "completed" } }),
      JSON.stringify({ ts: 1400, event: { type: "run_summary" } }),
    ].join("\n");
    await withTempLog(jsonl, async (logPath) => {
      const router = v2Router({ eventLogPath: logPath });
      const handler = getRunsHandler(router);
      const { res, mock } = makeRes();
      await handler({} as import("express").Request, res);
      assert.equal(mock.statusCode, 200);
      const body = mock.body as {
        runs: Array<{ derived: { runId?: string; preset?: string; finalPhase?: string; hasSummary: boolean }; recordCount: number; isSessionBoundary: boolean }>;
        malformed: number;
        totalRecords: number;
      };
      assert.equal(body.runs.length, 2); // session boundary + run
      assert.equal(body.runs[0].isSessionBoundary, true);
      assert.equal(body.runs[1].isSessionBoundary, false);
      assert.equal(body.runs[1].derived.runId, "r1");
      assert.equal(body.runs[1].derived.preset, "blackboard");
      assert.equal(body.runs[1].derived.finalPhase, "completed");
      assert.equal(body.runs[1].derived.hasSummary, true);
      assert.equal(body.totalRecords, 5);
      assert.equal(body.malformed, 0);
    });
  });

  it("counts malformed lines without erroring", async () => {
    const jsonl =
      JSON.stringify({ ts: 1, event: { type: "ok" } }) +
      "\n{not valid json}\n" +
      JSON.stringify({ ts: 2, event: { type: "also-ok" } });
    await withTempLog(jsonl, async (logPath) => {
      const router = v2Router({ eventLogPath: logPath });
      const handler = getRunsHandler(router);
      const { res, mock } = makeRes();
      await handler({} as import("express").Request, res);
      const body = mock.body as { malformed: number; totalRecords: number };
      assert.equal(body.malformed, 1);
      assert.equal(body.totalRecords, 2);
    });
  });

  it("includes the source path in the response", async () => {
    await withTempLog("", async (logPath) => {
      const router = v2Router({ eventLogPath: logPath });
      const handler = getRunsHandler(router);
      const { res, mock } = makeRes();
      await handler({} as import("express").Request, res);
      const body = mock.body as { source: string };
      assert.equal(body.source, logPath);
    });
  });
});
