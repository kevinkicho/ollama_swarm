import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  councilRunIdShort,
  loadPendingExecutionTodos,
  pendingTodosFromQueue,
  persistCouncilPendingTodos,
  pendingExecutionTodosPath,
  savePendingExecutionTodos,
  seedPendingTodosToQueue,
} from "./councilExecutionResume.js";
import { TodoQueue } from "./blackboard/TodoQueue.js";

describe("councilExecutionResume", () => {
  it("councilRunIdShort uses first 8 chars", () => {
    assert.equal(councilRunIdShort("6cb20b27-9db7-4ef9-80e7-3a7934029f48"), "6cb20b27");
  });

  it("round-trips pending todos under logs/<short-runId>/", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-resume-"));
    const runId = "6cb20b27-9db7-4ef9-80e7-3a7934029f48";
    const todos = [
      {
        description: "Populate database",
        expectedFiles: ["data/superconductor_database.json"],
        createdBy: "resume",
      },
    ];
    savePendingExecutionTodos(dir, runId, todos, ["done hint"]);
    const filePath = pendingExecutionTodosPath(dir, runId);
    assert.ok(existsSync(filePath));
    assert.match(filePath, /logs[\\/]6cb20b27[\\/]pending-execution-todos\.json$/);
    const loaded = loadPendingExecutionTodos(dir, runId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.description, "Populate database");
  });

  it("loads when resume id is already the 8-char prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-resume-"));
    const runId = "6cb20b27-9db7-4ef9-80e7-3a7934029f48";
    savePendingExecutionTodos(dir, runId, [
      { description: "Fix README", expectedFiles: ["README.md"] },
    ]);
    const loaded = loadPendingExecutionTodos(dir, "6cb20b27");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.expectedFiles[0], "README.md");
  });

  it("pendingTodosFromQueue keeps pending and in-progress only", () => {
    const q = new TodoQueue();
    q.post({ description: "pending one", expectedFiles: ["a.md"], createdBy: "x" });
    q.post({ description: "will complete", expectedFiles: ["b.md"], createdBy: "x" });
    const claimed = q.dequeue("w1");
    assert.equal(claimed?.description, "pending one");
    const finishing = q.dequeue("w2");
    q.complete(finishing!.id);
    const pending = pendingTodosFromQueue(q.list());
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.description, "pending one");
  });

  it("seedPendingTodosToQueue posts into TodoQueue", () => {
    const q = new TodoQueue();
    const n = seedPendingTodosToQueue(
      [{ description: "todo", expectedFiles: ["f.md"], createdBy: "resume" }],
      (input) => q.post(input),
    );
    assert.equal(n, 1);
    assert.equal(q.counts().pending, 1);
  });

  it("persistCouncilPendingTodos writes only unfinished todos", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-resume-"));
    const runId = "abc-def0-1234-5678-90abcdef1234";
    const q = new TodoQueue();
    q.post({ description: "still pending", expectedFiles: ["x.md"], createdBy: "s" });
    q.post({ description: "finished", expectedFiles: ["y.md"], createdBy: "s" });
    const first = q.dequeue("agent-2");
    assert.equal(first?.description, "still pending");
    const second = q.dequeue("agent-3");
    assert.equal(second?.description, "finished");
    q.complete(second!.id);
    const wrote = persistCouncilPendingTodos(dir, runId, q.list());
    assert.equal(wrote, true);
    const raw = JSON.parse(readFileSync(pendingExecutionTodosPath(dir, runId), "utf8"));
    assert.equal(raw.todos.length, 1);
    assert.equal(raw.todos[0].description, "still pending");
    assert.ok(Array.isArray(raw.completedTodoHints));
    assert.equal(raw.completedTodoHints[0], "finished");
  });
});