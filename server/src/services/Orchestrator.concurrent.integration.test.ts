// PR-4: concurrent multi-run isolation — WS filter + per-run quota.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Broadcaster } from "../ws/broadcast.js";
import type { SwarmEvent } from "../types.js";
import { tokenTracker } from "./ollamaProxy.js";

interface FakeWs {
  readyState: number;
  OPEN: number;
  sent: string[];
  send(data: string): void;
  on(): void;
}

function makeFakeWs(): FakeWs {
  return { readyState: 1, OPEN: 1, sent: [], send(d) { this.sent.push(d); }, on() {} };
}

function seedClient(bc: Broadcaster, ws: FakeWs, filter?: string): void {
  const internal = bc as unknown as { clients: Map<unknown, { runIdFilter?: string }> };
  internal.clients.set(ws, filter ? { runIdFilter: filter } : {});
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync('git add README.md && git -c user.email=t@test.com -c user.name=t commit -m init', {
    cwd: dir,
    stdio: "ignore",
    shell: "/bin/bash",
  });
}

afterEach(() => {
  tokenTracker.clearQuotaState();
});

test("concurrent — WS client ?runId=A receives zero events with runId=B", () => {
  const bc = new Broadcaster();
  const wsA = makeFakeWs();
  const wsB = makeFakeWs();
  seedClient(bc, wsA, "run-A");
  seedClient(bc, wsB, "run-B");

  const events: SwarmEvent[] = [
    { type: "agent_state", agent: { id: "agent-1", index: 1, status: "ready" }, runId: "run-A" },
    { type: "transcript_append", entry: { id: "e1", role: "system", text: "A", ts: 1 }, runId: "run-A" },
    { type: "agent_state", agent: { id: "agent-1", index: 1, status: "thinking" }, runId: "run-B" },
    { type: "swarm_state", phase: "executing", round: 1, runId: "run-B" },
  ];
  for (const e of events) bc.broadcast(e);

  assert.equal(wsA.sent.length, 2);
  assert.equal(wsB.sent.length, 2);
  for (const payload of wsA.sent) {
    const parsed = JSON.parse(payload) as { runId?: string };
    assert.notEqual(parsed.runId, "run-B");
  }
  for (const payload of wsB.sent) {
    const parsed = JSON.parse(payload) as { runId?: string };
    assert.notEqual(parsed.runId, "run-A");
  }
});

test("concurrent — per-run quota walls are isolated", () => {
  tokenTracker.markQuotaExhausted(429, "weekly quota", "persistent", "run-A");
  assert.equal(tokenTracker.shouldHaltOnQuota("run-A"), true);
  assert.equal(tokenTracker.shouldHaltOnQuota("run-B"), false);
  tokenTracker.clearQuotaState("run-A");
  assert.equal(tokenTracker.shouldHaltOnQuota("run-A"), false);
});

test("concurrent — distinct clone paths can be prepared for overlapping runs", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-concurrent-"));
  try {
    const cloneA = join(root, "swarm-test-a");
    const cloneB = join(root, "swarm-test-b");
    initGitRepo(cloneA);
    initGitRepo(cloneB);
    assert.notEqual(cloneA, cloneB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});