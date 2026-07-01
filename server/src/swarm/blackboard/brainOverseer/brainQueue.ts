// Brain queue — coordinates system work and project runs.
//
// Rules:
// 1. System work (patches) must complete before project runs start
// 2. Patches only apply when ALL runs are stopped
// 3. No concurrent system work
// 4. Project runs can parallel (if no file conflicts)

export type QueueItemType = "system" | "project" | "analysis";

export interface QueueItem {
  id: string;
  type: QueueItemType;
  priority: "high" | "medium" | "low";
  title: string;
  execute: () => Promise<void>;
  createdAt: number;
}

export interface BrainQueue {
  /** Add an item to the queue. */
  enqueue(item: Omit<QueueItem, "id" | "createdAt">): string;
  /** Process the next item in the queue. */
  processNext(): Promise<boolean>;
  /** Get queue status. */
  getStatus(): { pending: number; processing: boolean; current: QueueItem | null };
  /** Check if system work can be done (no project runs active). */
  canDoSystemWork(activeRunCount: number): boolean;
}

/**
 * Create a brain queue with coordination rules.
 */
export function createBrainQueue(): BrainQueue {
  const queue: QueueItem[] = [];
  let processing = false;
  let current: QueueItem | null = null;

  return {
    enqueue(item) {
      const id = `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entry: QueueItem = { ...item, id, createdAt: Date.now() };
      queue.push(entry);
      // Sort by priority: high > medium > low, then by type (system > project > analysis)
      queue.sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const typeOrder = { system: 0, project: 1, analysis: 2 };
        const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (pDiff !== 0) return pDiff;
        return typeOrder[a.type] - typeOrder[b.type];
      });
      return id;
    },

    async processNext() {
      if (processing || queue.length === 0) return false;

      processing = true;
      current = queue.shift() ?? null;

      if (!current) {
        processing = false;
        return false;
      }

      try {
        await current.execute();
      } catch (err) {
        console.error(`[brain-queue] Failed to execute ${current.title}: ${err instanceof Error ? err.message : err}`);
      } finally {
        current = null;
        processing = false;
      }

      return true;
    },

    getStatus() {
      return {
        pending: queue.length,
        processing,
        current,
      };
    },

    canDoSystemWork(activeRunCount) {
      // System work (patches) only when ALL runs are stopped
      return activeRunCount === 0 && !processing;
    },
  };
}
