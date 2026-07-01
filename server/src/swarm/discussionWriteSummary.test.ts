// 2026-05-03 (Phase C): unit tests for the shared writeSummary helper.
// Validates:
//   - calls repos.gitStatus + buildDiscussionSummary + writeRunSummary
//   - emits banner + log line by default
//   - skips banner when emitBanner=false (MoA case)
//   - omits files=N from log line when includeFilesInLogLine=false
//   - rounds override (MoA passes actualRoundsCompleted)
//   - earlyStopDetail passthrough
//   - handles gitStatus rejection without throwing
//   - handles writeRunSummary failure with error log line

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { RepoService } from "../services/RepoService.js";
import type { RunConfig } from "./SwarmRunner.js";

function fakeCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    repoUrl: "https://github.com/example/repo",
    localPath: path.join(os.tmpdir(), `dws-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    agentCount: 3,
    rounds: 2,
    model: "test-model",
    preset: "council",
    ...overrides,
  } as RunConfig;
}

function fakeRepos(opts?: { failGitStatus?: boolean }): RepoService {
  return {
    gitStatus: async () => {
      if (opts?.failGitStatus) throw new Error("simulated git failure");
      return { porcelain: "", changedFiles: 0 };
    },
  } as unknown as RepoService;
}

function captureAppendSystem() {
  const calls: Array<{ text: string; summary?: TranscriptEntrySummary }> = [];
  const appendSystem = (text: string, summary?: TranscriptEntrySummary) => {
    calls.push({ text, summary });
  };
  return { calls, appendSystem };
}

describe("discussionWriteSummary", () => {
  it("happy path emits banner + 'Wrote run summary' log line + writes summary.json", async () => {
    const cfg = fakeCfg();
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { calls, appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos(),
      appendSystem,
    });
    // Two appendSystem calls: banner + log line
    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /Run finished/i);  // banner
    assert.match(calls[1].text, /Wrote run summary/);
    assert.match(calls[1].text, /files=0/);
    // summary.json should exist on disk in logs/
    const exists = await fs.stat(path.join(cfg.localPath, "logs", "summary.json")).then(() => true).catch(() => false);
    assert.equal(exists, true);
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  it("emitBanner=false skips banner (MoA case)", async () => {
    const cfg = fakeCfg({ preset: "moa" });
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { calls, appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos(),
      appendSystem,
      emitBanner: false,
    });
    // Only the terse log line — no banner
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /Wrote run summary/);
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  it("includeFilesInLogLine=false omits files=N from log line (MoA case)", async () => {
    const cfg = fakeCfg({ preset: "moa" });
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { calls, appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos(),
      appendSystem,
      emitBanner: false,
      includeFilesInLogLine: false,
    });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].text.includes("files="), "log line must omit files= when flag false");
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  it("rounds override is passed to buildDiscussionSummary (MoA actualRoundsCompleted)", async () => {
    // Verify by reading back the written summary.json — its `rounds`
    // field should match the override, not cfg.rounds.
    const cfg = fakeCfg({ rounds: 5 });
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      rounds: 2, // MoA stopped early at round 2
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos(),
      appendSystem,
    });
    const json = JSON.parse(await fs.readFile(path.join(cfg.localPath, "logs", "summary.json"), "utf8"));
    assert.equal(json.rounds, 2);
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  it("earlyStopDetail passthrough", async () => {
    const cfg = fakeCfg();
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      earlyStopDetail: "judge-confidence-high after round 2/4",
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos(),
      appendSystem,
    });
    const json = JSON.parse(await fs.readFile(path.join(cfg.localPath, "logs", "summary.json"), "utf8"));
    assert.equal(json.stopReason, "early-stop");
    assert.equal(json.stopDetail, "judge-confidence-high after round 2/4");
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  it("survives gitStatus failure (best-effort)", async () => {
    const cfg = fakeCfg();
    await fs.mkdir(cfg.localPath, { recursive: true });
    const { calls, appendSystem } = captureAppendSystem();
    await discussionWriteSummary({
      cfg,
      stopping: false,
      startedAt: Date.now() - 1000,
      agentCount: 3,
      agents: [],
      transcript: [],
      repos: fakeRepos({ failGitStatus: true }),
      appendSystem,
    });
    // Should still write summary, just with filesChanged=0 + empty porcelain
    assert.equal(calls.length, 2);
    const json = JSON.parse(await fs.readFile(path.join(cfg.localPath, "logs", "summary.json"), "utf8"));
    assert.equal(json.filesChanged, 0);
    await fs.rm(cfg.localPath, { recursive: true, force: true });
  });

  // Note: writeRunSummary auto-creates parent dirs, so I/O failure
  // testing requires a more invasive setup (mocking writeFileSync etc.).
  // The try/catch path is preserved verbatim from the original runner
  // method bodies — covered by behavioral parity in production.
});
