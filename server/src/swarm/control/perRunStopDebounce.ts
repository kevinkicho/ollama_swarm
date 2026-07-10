/**
 * Per-runId stop-click debounce for SWARM_DRAIN_ON_STOP double-click kill.
 * Process-global timestamps caused concurrent-run crosstalk (stop B treated
 * as second click for A).
 */

export class PerRunStopDebounce {
  private readonly lastAt = new Map<string, number>();

  get(runId: string): number | null {
    return this.lastAt.get(runId) ?? null;
  }

  touch(runId: string, now: number = Date.now()): void {
    this.lastAt.set(runId, now);
  }

  clear(runId: string): void {
    this.lastAt.delete(runId);
  }

  /** Drop entries for runs that are no longer active. */
  retain(activeRunIds: ReadonlySet<string>): void {
    for (const id of this.lastAt.keys()) {
      if (!activeRunIds.has(id)) this.lastAt.delete(id);
    }
  }
}
