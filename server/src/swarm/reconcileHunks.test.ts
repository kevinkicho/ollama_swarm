import test from "node:test";
import assert from "node:assert";
import {
  detectConflicts,
  mergeNonOverlapping,
  reconcilePick,
  reconcileSequential,
  reconcileVote,
  type HunkProposal,
} from "./reconcileHunks.js";
import type { Hunk } from "./blackboard/applyHunks.js";

const createHunk = (file: string, search: string, replace: string): Hunk =>
  ({ op: "replace" as const, file, search, replace });

const createFileHunk = (file: string, content: string): Hunk =>
  ({ op: "create" as const, file, content });

test("detectConflicts — no conflicts with disjoint files", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/a.ts", "old", "new")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/b.ts", "old", "new")], timestamp: 2 },
  ];

  const conflicts = detectConflicts(proposals);
  assert.strictEqual(conflicts.length, 0);
});

test("detectConflicts — detects same-file creation conflict", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createFileHunk("src/new.ts", "content a")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createFileHunk("src/new.ts", "content b")], timestamp: 2 },
  ];

  const conflicts = detectConflicts(proposals);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0]?.type, "file_creation");
  assert.strictEqual(conflicts[0]?.file, "src/new.ts");
});

test("detectConflicts — detects same search anchor", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/file.ts", "function foo() {}", "function bar() {}")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/file.ts", "function foo() {}", "function baz() {}")], timestamp: 2 },
  ];

  const conflicts = detectConflicts(proposals);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0]?.type, "same_anchor");
});

test("detectConflicts — no conflict with different search anchors", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/file.ts", "function a()", "function aa()")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/file.ts", "function b()", "function bb()")], timestamp: 2 },
  ];

  const conflicts = detectConflicts(proposals);
  assert.strictEqual(conflicts.length, 0);
});

test("mergeNonOverlapping — merges disjoint hunks", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/a.ts", "old", "new")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/b.ts", "old", "new")], timestamp: 2 },
  ];

  const result = mergeNonOverlapping(proposals);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hunks.length, 2);
  assert.strictEqual(result.conflicts.length, 0);
});

test("mergeNonOverlapping — fails on conflicts", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/file.ts", "old", "new a")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/file.ts", "old", "new b")], timestamp: 2 },
  ];

  const result = mergeNonOverlapping(proposals);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.hunks.length, 0);
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.rejectedProposals.length, 2);
});

test("reconcilePick — selects winner's hunks", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/a.ts", "old", "new")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/b.ts", "old", "new")], timestamp: 2 },
  ];

  const result = reconcilePick(proposals, "a2");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hunks.length, 1);
  assert.strictEqual(result.hunks[0]?.file, "src/b.ts");
  assert.strictEqual(result.rejectedProposals.length, 1);
  assert.strictEqual(result.rejectedProposals[0]?.agentId, "a1");
});

test("reconcilePick — fails when winner not found", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/a.ts", "old", "new")], timestamp: 1 },
  ];

  const result = reconcilePick(proposals, "nonexistent");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.rejectedProposals.length, 1);
});

test("reconcileVote — picks first agent's hunks for each file (placeholder)", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 1, hunks: [createHunk("src/file.ts", "old", "new a")], timestamp: 1 },
    { agentId: "a2", agentIndex: 2, hunks: [createHunk("src/file.ts", "old2", "new b")], timestamp: 2 },
  ];

  const result = reconcileVote(proposals, {});
  assert.strictEqual(result.ok, true);
  // First agent wins for the file (placeholder logic)
  assert.strictEqual(result.hunks[0]?.file, "src/file.ts");
  assert.ok(result.hunks.length >= 1);
});

test("reconcileSequential — applies in order", () => {
  const proposals: HunkProposal[] = [
    { agentId: "a1", agentIndex: 2, hunks: [createHunk("src/file.ts", "original", "second")], timestamp: 1 },
    { agentId: "a2", agentIndex: 1, hunks: [createHunk("src/file.ts", "original", "first")], timestamp: 2 },
  ];

  // Agent-1 (index 1) goes first, changes "original" -> "first"
  // Agent-2 (index 2) tries to change "original" but it's gone -> fails
  const currentFiles: Record<string, string | null> = {
    "src/file.ts": "original",
  };

  const result = reconcileSequential(proposals, currentFiles);
  // One hunk applied (agent 1's), one rejected (agent 2's)
  assert.strictEqual(result.hunks.length, 1);
  assert.ok(result.rejectedProposals.length >= 1);
});