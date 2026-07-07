import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PostTodoInput, QueuedTodo } from "./blackboard/TodoQueue.js";

/** Council logs dirs use the first 8 chars of the run UUID. */
export function councilRunIdShort(runId: string): string {
  return runId.trim().slice(0, 8);
}

export interface PendingExecutionTodo {
  description: string;
  expectedFiles: string[];
  createdBy?: string;
}

export interface PendingExecutionTodosFile {
  schemaVersion: 1;
  sourceRunId: string;
  writtenAt: number;
  completedTodoHints?: string[];
  todos: PendingExecutionTodo[];
}

export function pendingExecutionTodosPath(clonePath: string, sourceRunId: string): string {
  return path.join(clonePath, "logs", councilRunIdShort(sourceRunId), "pending-execution-todos.json");
}

function readPendingTodosFile(filePath: string): PendingExecutionTodo[] {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as PendingExecutionTodosFile;
    if (!Array.isArray(raw.todos)) return [];
    return raw.todos.filter(
      (t) => typeof t.description === "string" && Array.isArray(t.expectedFiles),
    );
  } catch {
    return [];
  }
}

export function loadPendingExecutionTodos(
  clonePath: string,
  sourceRunId: string,
): PendingExecutionTodo[] {
  const trimmed = sourceRunId.trim();
  if (!trimmed) return [];

  const primary = pendingExecutionTodosPath(clonePath, trimmed);
  if (existsSync(primary)) return readPendingTodosFile(primary);

  // Back-compat: full UUID directory before short-id normalization.
  if (trimmed.length > 8) {
    const legacy = path.join(clonePath, "logs", trimmed, "pending-execution-todos.json");
    if (existsSync(legacy)) return readPendingTodosFile(legacy);
  }

  return [];
}

/** Export still-actionable todos from the in-memory queue. */
export function pendingTodosFromQueue(todos: readonly QueuedTodo[]): PendingExecutionTodo[] {
  return todos
    .filter((t) => t.status === "pending" || t.status === "in-progress")
    .map((t) => ({
      description: t.description,
      expectedFiles: [...t.expectedFiles],
      createdBy: t.createdBy,
    }));
}

export function completedTodoHintsFromQueue(todos: readonly QueuedTodo[]): string[] {
  return todos
    .filter((t) => t.status === "completed")
    .map((t) => t.description.slice(0, 120));
}

export function savePendingExecutionTodos(
  clonePath: string,
  sourceRunId: string,
  todos: PendingExecutionTodo[],
  completedTodoHints: string[] = [],
): void {
  const filePath = pendingExecutionTodosPath(clonePath, sourceRunId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: PendingExecutionTodosFile = {
    schemaVersion: 1,
    sourceRunId,
    writtenAt: Date.now(),
    completedTodoHints,
    todos,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function seedPendingTodosToQueue(
  todos: PendingExecutionTodo[],
  post: (input: PostTodoInput) => string,
  createdBy = "resume",
): number {
  let n = 0;
  for (const t of todos) {
    post({
      description: t.description,
      expectedFiles: t.expectedFiles,
      createdBy: t.createdBy ?? createdBy,
    });
    n++;
  }
  return n;
}

/** Persist remaining execution todos so a later run can resume after crash/stop. */
export function persistCouncilPendingTodos(
  clonePath: string,
  runId: string,
  todos: readonly QueuedTodo[],
): boolean {
  const pending = pendingTodosFromQueue(todos);
  if (pending.length === 0) return false;
  savePendingExecutionTodos(
    clonePath,
    runId,
    pending,
    completedTodoHintsFromQueue(todos),
  );
  return true;
}