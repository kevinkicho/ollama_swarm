import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSummaryTokenRows,
  summaryRowsToUsageRecords,
} from "./usageFromRunSummaries.js";

test("collectSummaryTokenRows reads totalPromptTokens from logs/", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-sum-"));
  try {
    const logs = join(root, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "summary-abcd1234-2026-07-08T12-00-00-000Z.json"),
      JSON.stringify({
        runId: "abcd1234-1111-2222-3333-444444444444",
        startedAt: Date.now() - 60_000,
        endedAt: Date.now() - 30_000,
        preset: "council",
        model: "deepseek-v4-flash:cloud",
        totalPromptTokens: 1_000_000,
        totalResponseTokens: 200_000,
      }),
    );
    const rows = collectSummaryTokenRows([root]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.promptTokens, 1_000_000);
    assert.equal(rows[0]!.responseTokens, 200_000);
    const recs = summaryRowsToUsageRecords(rows);
    assert.equal(recs[0]!.promptTokens, 1_000_000);
    assert.match(recs[0]!.path ?? "", /^summary-backfill:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSummaryTokenRows falls back to agent tokensIn/Out", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-sum2-"));
  try {
    const logs = join(root, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "summary.json"),
      JSON.stringify({
        runId: "eeeeeeee-1111-2222-3333-444444444444",
        startedAt: Date.now() - 10_000,
        endedAt: Date.now(),
        agents: [
          { agentIndex: 1, tokensIn: 500, tokensOut: 100 },
          { agentIndex: 2, tokensIn: 300, tokensOut: 50 },
        ],
      }),
    );
    const rows = collectSummaryTokenRows([root]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.promptTokens, 800);
    assert.equal(rows[0]!.responseTokens, 150);
    assert.equal(rows[0]!.estimated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSummaryTokenRows estimates when token fields are zero but turns exist", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-sum3-"));
  try {
    const logs = join(root, "logs");
    mkdirSync(logs, { recursive: true });
    const endedAt = Date.now() - 60_000;
    writeFileSync(
      join(logs, "summary-zero-tokens.json"),
      JSON.stringify({
        runId: "ffffffff-1111-2222-3333-444444444444",
        startedAt: endedAt - 1_300_000,
        endedAt,
        wallClockMs: 1_300_000,
        totalPromptTokens: 0,
        totalResponseTokens: 0,
        agents: [
          { agentIndex: 1, turnsTaken: 4, totalAttempts: 4, tokensIn: null, tokensOut: null },
          { agentIndex: 2, turnsTaken: 3, totalAttempts: 4, tokensIn: null, tokensOut: null },
        ],
        transcript: [
          { role: "agent", text: "x".repeat(4000), thoughts: "y".repeat(8000) },
        ],
      }),
    );
    const rows = collectSummaryTokenRows([root]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.estimated, true);
    // 8 attempts * 22k floor ≈ 176k
    assert.ok(rows[0]!.promptTokens + rows[0]!.responseTokens >= 150_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
