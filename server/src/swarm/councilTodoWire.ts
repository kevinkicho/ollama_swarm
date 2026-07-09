import { v2QueueTodoToWireTodo } from "./blackboard/boardWireCompat.js";
import type { QueuedTodo, TodoQueue } from "./blackboard/TodoQueue.js";

type EmitFn = (e: unknown) => void;

export function emitCouncilTodoPosted(emit: EmitFn, queue: TodoQueue, id: string): void {
  const qt = queue.get(id);
  if (!qt) return;
  emit({ type: "todo_posted", todo: v2QueueTodoToWireTodo(qt) });
}

export function emitCouncilTodoClaimed(emit: EmitFn, todo: QueuedTodo): void {
  const wire = v2QueueTodoToWireTodo(todo);
  if (wire.claim) {
    emit({ type: "todo_claimed", todoId: todo.id, claim: wire.claim });
  }
}

export function emitCouncilTodoCommitted(emit: EmitFn, todoId: string): void {
  emit({ type: "todo_committed", todoId });
}

export function emitCouncilTodoSkipped(emit: EmitFn, queue: TodoQueue, todoId: string): void {
  const qt = queue.get(todoId);
  emit({ type: "todo_skipped", todoId, reason: qt?.reason ?? "" });
}

export function emitCouncilTodoFailed(emit: EmitFn, queue: TodoQueue, todoId: string): void {
  const qt = queue.get(todoId);
  emit({
    type: "todo_failed",
    todoId,
    reason: qt?.reason ?? "",
    replanCount: qt?.retries ?? 0,
  });
}