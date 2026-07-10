/**
 * Hypothesis group settlement after a winning todo commits.
 * Extracted from workerRunner.ts.
 */

import type { TodoQueue } from "./TodoQueue.js";

export interface HypothesisSettleCtx {
  getTodoQueue: () => TodoQueue;
  getHypothesisGroupAborts: () => Map<string, AbortController>;
  appendSystem: (msg: string) => void;
}

export function maybeSettleHypothesisGroup(
  ctx: HypothesisSettleCtx,
  todoId: string,
): void {
  const t = ctx.getTodoQueue().get(todoId);
  if (!t || !t.groupId) return;
  const groupId = t.groupId;
  const settled = ctx.getTodoQueue().markGroupSettled(groupId, todoId);
  const ctrl = ctx.getHypothesisGroupAborts().get(groupId);
  if (ctrl) {
    ctrl.abort();
    ctx.getHypothesisGroupAborts().delete(groupId);
  }
  if (settled.skipped.length > 0) {
    ctx.appendSystem(
      `[T-Item-3] hypothesis group ${groupId} settled: winner=${todoId.slice(0, 8)}; cancelled ${settled.skipped.length} alternative(s) (${settled.skipped.map((id) => id.slice(0, 8)).join(", ")}).`,
    );
  } else {
    ctx.appendSystem(
      `[T-Item-3] hypothesis group ${groupId} settled: winner=${todoId.slice(0, 8)}; no other alternatives left to cancel.`,
    );
  }
}
