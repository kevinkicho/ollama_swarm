// V2 substrate integration test: proves the four substrate pieces
// (runStateMachine, RunStateObserver, TodoQueueV2, WorkerPipelineV2)
// compose correctly when driven by a realistic event sequence.
//
// No real network, no real fs/git, no BlackboardRunner — pure
// substrate exercise. If this passes, the V2 cutover (Step 5c)
// has working primitives to build on. If it fails, Step 5c would
// fail in the same way at runtime.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TodoQueueV2 } from "./TodoQueueV2.js";
import { RunStateObserver } from "./RunStateObserver.js";
import {
  applyAndCommitV2,
  type FilesystemAdapter,
  type GitAdapter,
} from "./WorkerPipelineV2.js";
import type { Hunk } from "./applyHunks.js";

describe("V2 substrate integration", () => {
  it("simulates a 3-todo run end-to-end and lands in completed phase", async () => {
    // ── SETUP ────────────────────────────────────────────────────
    // 3 todos, each with a single replace-hunk against a separate
    // file. After all 3 commit, the auditor "returns" with
    // allCriteriaResolved=true and we expect V2 → completed.
    const queue = new TodoQueueV2();
    const observer = new RunStateObserver({
      getCtx: () => ({
        openTodos: queue.counts().pending,
        claimedTodos: queue.counts().inProgress,
        staleTodos: 0,
        auditInvocations: 0,
        maxAuditInvocations: 3,
        currentTier: 1,
        maxTiers: 1,
        allCriteriaResolved: false,
      }),
    });

    const filesystem = makeFakeFs({
      "src/a.ts": "// alpha placeholder",
      "src/b.ts": "// beta placeholder",
      "src/c.ts": "// gamma placeholder",
    });
    const git = makeFakeGit();

    // ── PHASE 1: start → spawning → planning ──────────────────────
    observer.apply({ type: "start", ts: 1000 });
    assert.equal(observer.getState().phase, "spawning");

    observer.apply({ type: "spawned", ts: 1100, agentCount: 4 });
    assert.equal(observer.getState().phase, "planning");

    observer.apply({ type: "contract-built", ts: 1200, criteriaCount: 3 });
    assert.equal(observer.getState().phase, "planning"); // stays in planning

    // Planner posts 3 todos
    queue.post({ description: "edit alpha", expectedFiles: ["src/a.ts"], createdBy: "planner" });
    queue.post({ description: "edit beta", expectedFiles: ["src/b.ts"], createdBy: "planner" });
    queue.post({ description: "edit gamma", expectedFiles: ["src/c.ts"], createdBy: "planner" });
    observer.apply({ type: "todos-posted", ts: 1300, count: 3 });
    assert.equal(observer.getState().phase, "executing");

    // ── PHASE 2: workers drain the queue ──────────────────────────
    const workerHunks: Record<string, Hunk[]> = {
      "src/a.ts": [{ op: "replace", file: "src/a.ts", search: "// alpha placeholder", replace: "// alpha REAL" }],
      "src/b.ts": [{ op: "replace", file: "src/b.ts", search: "// beta placeholder", replace: "// beta REAL" }],
      "src/c.ts": [{ op: "replace", file: "src/c.ts", search: "// gamma placeholder", replace: "// gamma REAL" }],
    };

    let dequeueTs = 1400;
    let workerNum = 2;
    while (queue.counts().pending > 0) {
      const todo = queue.dequeue(`worker-${workerNum}`, undefined, dequeueTs);
      if (!todo) break;
      const hunks = workerHunks[todo.expectedFiles[0]];
      const out = await applyAndCommitV2({
        todoId: todo.id,
        workerId: todo.workerId!,
        expectedFiles: todo.expectedFiles,
        hunks,
        fs: filesystem.fs,
        git: git.git,
      });
      assert.equal(out.ok, true, `applyAndCommitV2 should succeed for ${todo.id}`);
      queue.complete(todo.id, dequeueTs + 50);
      observer.apply({
        type: "todo-committed",
        ts: dequeueTs + 50,
        remainingTodos: queue.counts().pending,
      });
      dequeueTs += 100;
      workerNum = workerNum === 4 ? 2 : workerNum + 1;
    }

    // After draining: queue empty + V2 reducer transitioned to auditing
    assert.equal(queue.counts().pending, 0);
    assert.equal(queue.counts().inProgress, 0);
    assert.equal(queue.counts().completed, 3);
    assert.equal(observer.getState().phase, "auditing");

    // ── PHASE 3: auditor returns all criteria resolved ────────────
    observer.apply({ type: "auditor-fired", ts: 2000 });
    observer.apply({
      type: "auditor-returned",
      ts: 2100,
      allCriteriaResolved: true,
      newTodosCount: 0,
    });
    // currentTier=1, maxTiers=1 → no tier-up; goes straight to completed
    assert.equal(observer.getState().phase, "completed");

    // ── VERIFY: 3 commits on git, 3 files updated ─────────────────
    assert.equal(git.state.commits.length, 3);
    assert.equal(filesystem.state.files.get("src/a.ts"), "// alpha REAL");
    assert.equal(filesystem.state.files.get("src/b.ts"), "// beta REAL");
    assert.equal(filesystem.state.files.get("src/c.ts"), "// gamma REAL");

    // ── VERIFY: V2 reducer terminated cleanly (post-cutover, divergence
    // tracking is gone — agreement is verified by V2 reaching the
    // expected terminal state on its own).
    assert.equal(observer.getState().phase, "completed");
  });

  it("simulates a tier-up cycle: tier 1 complete → tier 2 starts", async () => {
    const queue = new TodoQueueV2();
    const observer = new RunStateObserver({
      getCtx: () => ({
        openTodos: queue.counts().pending,
        claimedTodos: queue.counts().inProgress,
        staleTodos: 0,
        auditInvocations: 0,
        maxAuditInvocations: 3,
        currentTier: 1,
        maxTiers: 3,
        allCriteriaResolved: false,
      }),
    });
    observer.apply({ type: "start", ts: 1 });
    observer.apply({ type: "spawned", ts: 2, agentCount: 4 });
    observer.apply({ type: "contract-built", ts: 3, criteriaCount: 1 });

    queue.post({ description: "tier 1", expectedFiles: ["a.ts"], createdBy: "p" });
    observer.apply({ type: "todos-posted", ts: 4, count: 1 });

    const todo = queue.dequeue("worker-2");
    assert.ok(todo);
    queue.complete(todo!.id);
    observer.apply({ type: "todo-committed", ts: 5, remainingTodos: 0 });
    assert.equal(observer.getState().phase, "auditing");

    observer.apply({
      type: "auditor-returned",
      ts: 6,
      allCriteriaResolved: true,
      newTodosCount: 0,
    });
    // currentTier=1, maxTiers=3 → tier-up
    assert.equal(observer.getState().phase, "tier-up");

    observer.apply({ type: "tier-up-decision", ts: 7, promoted: true });
    assert.equal(observer.getState().phase, "planning");
  });

  it("V2 reducer terminates correctly even when fed extra events post-completion", async () => {
    // V2 cutover Phase 1a: this test was originally about the
    // observer's checkPhase firing a divergence when V1 wedged in
    // executing while V2 had reached completed. After cutover,
    // checkPhase + divergence tracking are gone. The remaining
    // value is verifying the reducer's terminal-state idempotence —
    // applying further events to a "completed" state must not
    // transition out.
    const queue = new TodoQueueV2();
    const observer = new RunStateObserver({
      getCtx: () => ({
        openTodos: queue.counts().pending,
        claimedTodos: queue.counts().inProgress,
        staleTodos: 0,
        auditInvocations: 0,
        maxAuditInvocations: 3,
        currentTier: 1,
        maxTiers: 1,
        allCriteriaResolved: false,
      }),
    });
    observer.apply({ type: "start", ts: 1 });
    observer.apply({ type: "spawned", ts: 2, agentCount: 4 });
    observer.apply({ type: "contract-built", ts: 3, criteriaCount: 1 });

    queue.post({ description: "x", expectedFiles: [], createdBy: "p" });
    observer.apply({ type: "todos-posted", ts: 4, count: 1 });
    const todo = queue.dequeue("w");
    queue.complete(todo!.id);
    observer.apply({ type: "todo-committed", ts: 5, remainingTodos: 0 });
    observer.apply({
      type: "auditor-returned",
      ts: 6,
      allCriteriaResolved: true,
      newTodosCount: 0,
    });
    assert.equal(observer.getState().phase, "completed");

    // Apply a stray event after completion — terminal state is sticky.
    observer.apply({ type: "todo-committed", ts: 7, remainingTodos: 0 });
    assert.equal(observer.getState().phase, "completed");
  });
});

interface FakeFsState {
  files: Map<string, string>;
}

function makeFakeFs(initial: Record<string, string> = {}): {
  fs: FilesystemAdapter;
  state: FakeFsState;
} {
  const state: FakeFsState = { files: new Map(Object.entries(initial)) };
  return {
    state,
    fs: {
      async read(path) {
        return state.files.has(path) ? (state.files.get(path) as string) : null;
      },
      async write(path, content) {
        state.files.set(path, content);
      },
    },
  };
}

interface FakeGitState {
  commits: Array<{ message: string; author: string; sha: string }>;
}

function makeFakeGit(): { git: GitAdapter; state: FakeGitState } {
  const state: FakeGitState = { commits: [] };
  let nextSha = 1;
  return {
    state,
    git: {
      async commitAll(message, author) {
        const sha = `sha${nextSha++}`;
        state.commits.push({ message, author, sha });
        return { ok: true, sha };
      },
    },
  };
}
