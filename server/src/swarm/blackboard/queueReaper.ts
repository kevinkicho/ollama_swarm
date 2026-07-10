import type { TodoQueue } from "./TodoQueue.js";
import type { BoardBroadcaster } from "./boardBroadcaster.js";
import { IN_PROGRESS_TTL_MS, REAPER_INTERVAL_MS } from "./BlackboardRunnerConstants.js";
import { stopAdaptiveWorkerWatchdog } from "./adaptiveWorkerWatchdog.js";
import type { AdaptiveWatchdogContext } from "./adaptiveWorkerWatchdog.js";

export interface QueueReaperContext {
  getReaperTimer: () => NodeJS.Timeout | undefined;
  setReaperTimer: (v: NodeJS.Timeout | undefined) => void;
  todoQueue: TodoQueue;
  appendSystem: (msg: string) => void;
  boardBroadcaster: BoardBroadcaster;
  bumpStaleEventCount: () => void;
  enqueueReplan: (todoId: string) => void;
  scheduleStateWrite: () => void;
  adaptiveWatchdogCtx: () => AdaptiveWatchdogContext;
}

export function startQueueReaper(ctx: QueueReaperContext): void {
  if (ctx.getReaperTimer()) return;
  const timer = setInterval(() => {
    const now = Date.now();
    const reaped = ctx.todoQueue.reapStaleInProgress(now, IN_PROGRESS_TTL_MS);
    // Pending-commit uses a longer TTL (auditor can be slow); 1.5× in-progress.
    const pendingCommitTtl = Math.round(IN_PROGRESS_TTL_MS * 1.5);
    const reapedPending = ctx.todoQueue.reapStalePendingCommit(now, pendingCommitTtl);

    if (reaped.length > 0) {
      ctx.appendSystem(
        `[v2-reaper] Reaped ${reaped.length} stale in-progress todo(s) past ${Math.round(IN_PROGRESS_TTL_MS / 60_000)}min TTL: ${reaped.join(", ")}`,
      );
      for (const id of reaped) {
        const t = ctx.todoQueue.get(id);
        const reason = t?.reason ?? `worker timeout (>${Math.round(IN_PROGRESS_TTL_MS / 60_000)}min in-progress)`;
        ctx.boardBroadcaster.emit({
          type: "todo_stale",
          todoId: id,
          reason,
          replanCount: t?.retries ?? 0,
        });
        ctx.bumpStaleEventCount();
        ctx.enqueueReplan(id);
      }
    }
    if (reapedPending.length > 0) {
      ctx.appendSystem(
        `[v2-reaper] Released ${reapedPending.length} stale pending-commit todo(s) past ${Math.round(pendingCommitTtl / 60_000)}min auditor TTL: ${reapedPending.join(", ")}`,
      );
      for (const id of reapedPending) {
        const t = ctx.todoQueue.get(id);
        ctx.boardBroadcaster.emit({
          type: "todo_stale",
          todoId: id,
          reason: t?.reason ?? "auditor timeout on pending-commit",
          replanCount: t?.retries ?? 0,
        });
        ctx.bumpStaleEventCount();
      }
    }
    if (reaped.length > 0 || reapedPending.length > 0) {
      ctx.scheduleStateWrite();
    }
  }, REAPER_INTERVAL_MS);
  timer.unref?.();
  ctx.setReaperTimer(timer);
}

export function stopQueueReaper(ctx: QueueReaperContext): void {
  const timer = ctx.getReaperTimer();
  if (timer) clearInterval(timer);
  ctx.setReaperTimer(undefined);
  stopAdaptiveWorkerWatchdog(ctx.adaptiveWatchdogCtx());
}