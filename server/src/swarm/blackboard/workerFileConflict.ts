// Serialize worker dispatch when expectedFiles overlap an in-progress todo.
// Hypothesis groups already had within-group overlap checks; this extends
// the same rule to ALL workers so two agents never race on the same file.

import { expectedFilesOverlap } from "./hypothesisGrouping.js";

export interface InProgressTodoSlice {
  id: string;
  expectedFiles: readonly string[];
  workerId?: string;
}

/** True when candidate would touch a file another worker is actively editing. */
export function hasActiveFileConflict(
  candidateFiles: readonly string[],
  inProgress: readonly InProgressTodoSlice[],
  excludeTodoId?: string,
): boolean {
  if (candidateFiles.length === 0) return false;
  for (const active of inProgress) {
    if (excludeTodoId && active.id === excludeTodoId) continue;
    if (expectedFilesOverlap(candidateFiles, active.expectedFiles)) return true;
  }
  return false;
}

export interface TodoFileOverlap {
  file: string;
  todoIds: string[];
}

/** Detect overlapping expectedFiles within a planner batch (provisioning guard). */
export function detectTodoBatchFileOverlaps(
  todos: readonly { description: string; expectedFiles: readonly string[] }[],
): TodoFileOverlap[] {
  const fileToTodos = new Map<string, string[]>();
  for (let i = 0; i < todos.length; i++) {
    const desc = todos[i]!.description.slice(0, 60);
    for (const f of todos[i]!.expectedFiles) {
      const list = fileToTodos.get(f) ?? [];
      list.push(desc);
      fileToTodos.set(f, list);
    }
  }
  const overlaps: TodoFileOverlap[] = [];
  for (const [file, todoIds] of fileToTodos.entries()) {
    if (todoIds.length > 1) overlaps.push({ file, todoIds });
  }
  return overlaps;
}