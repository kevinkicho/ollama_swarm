#!/usr/bin/env node
/**
 * Dev helper: injects a fake recent run summary so the /runs dropdown
 * and ?scan=1 react-scan sessions have data even without a real past run.
 *
 * Usage: node scripts/dev-inject-fake-run.mjs [optional-run-id]
 *
 * It writes to the same persisted files the server uses (known-parents, last-parent)
 * and creates a minimal summary json under logs/<short-id>/ so the server scanner picks it up.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const runId = process.argv[2] || `fake-${Date.now().toString(36)}`;
const short = runId.slice(0, 8);
const cwd = process.cwd();
const logsDir = path.join(cwd, 'logs', short);
const summaryPath = path.join(logsDir, `summary-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);

fs.mkdirSync(logsDir, { recursive: true });

const fakeSummary = {
  runId,
  preset: "blackboard",
  model: "deepseek-v4-flash:cloud",
  startedAt: Date.now() - 1000 * 60 * 60 * 3, // ~3h ago
  endedAt: Date.now() - 1000 * 60 * 60 * 1,
  wallClockMs: 1000 * 60 * 120,
  stopReason: "user",
  commits: 7,
  totalTodos: 12,
  localPath: "C:\\Users\\ysile\\Downloads\\workspace\\fake-project",
  clonePath: "C:\\Users\\ysile\\Downloads\\workspace\\fake-project",
  contract: { criteria: [{ description: "fake criterion" }] },
  agents: [
    { agentIndex: 1, turnsTaken: 5, totalAttempts: 5, meanLatencyMs: 1200 },
    { agentIndex: 2, turnsTaken: 4, totalAttempts: 4, meanLatencyMs: 980 },
  ],
  transcript: [],
  summary: { preset: "blackboard", agentCount: 3 },
};

fs.writeFileSync(summaryPath, JSON.stringify(fakeSummary, null, 2));
console.log('[dev-inject] wrote fake summary:', summaryPath);
console.log('[dev-inject] Note: this fake only populates the Runs dropdown via summaries. /status will 404 (expected for non-active fake); UI should not crash on it.');

// Update the persisted known-parents and last-parent (same files server uses)
const LAST_PARENT_FILE = path.join(os.tmpdir(), "ollama-swarm-last-parent.txt");
const KNOWN_PARENTS_FILE = path.join(os.tmpdir(), "ollama-swarm-known-parents.json");

const parent = cwd;
fs.writeFileSync(LAST_PARENT_FILE, parent, "utf8");

let known = [];
try {
  known = JSON.parse(fs.readFileSync(KNOWN_PARENTS_FILE, "utf8"));
} catch {}
if (!known.includes(parent)) known.unshift(parent);
fs.writeFileSync(KNOWN_PARENTS_FILE, JSON.stringify(known.slice(0, 32)), "utf8");

console.log('[dev-inject] updated last-parent + known-parents (tmp files)');
console.log('[dev-inject] Now open the app and click the "Runs" topbar button (or visit / with ?scan=1 for react-scan).');
console.log(`[dev-inject] Suggested URL for scan session: http://localhost:8244/?scan=1 (switch to transcript/metrics tabs)`);
console.log(`[dev-inject] Fake runId: ${runId}`);