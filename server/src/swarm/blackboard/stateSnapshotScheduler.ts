// Extracted from BlackboardRunner.ts — debounced state-snapshot scheduler.
// Writes `<clone>/blackboard-state.json` on every phase change or board
// event. Uses trailing-edge debounce + write-again flag so rapid state
// changes coalesce and the latest state always lands on disk.

import path from "node:path";
import type { SwarmPhase } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract, Todo } from "./types.js";
import type { PerAgentStat } from "./summary.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import { buildStateSnapshot } from "./stateSnapshot.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { STATE_SNAPSHOT_DEBOUNCE_MS } from "./stateSnapshot.js";

export interface StateSnapshotContext {
  phase: SwarmPhase;
  round: number;
  runBootedAt: number | undefined;
  runStartedAt: number | undefined;
  tickAccumulatorActiveElapsedMs: number | undefined;
  active: RunConfig | undefined;
  contract: ExitContract | undefined;
  cloneContract: (c: ExitContract) => ExitContract;
  boardSnapshot: () => { todos: Todo[]; findings: any[] };
  buildPerAgentStats: () => PerAgentStat[];
  staleEventCount: number;
  auditInvocations: number;
  agentRoster: Array<{ id: string; index: number }>;
  terminationReason: string | undefined;
  completionDetail: string | undefined;
  currentTier: number;
  tiersCompleted: number;
  tierHistory: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    startedAt: number;
    endedAt: number;
  }>;
}

export class StateSnapshotScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private again = false;

  constructor(
    private readonly ctx: () => StateSnapshotContext,
    private readonly clonePath: () => string | undefined,
  ) {}

  schedule(): void {
    const { phase } = this.ctx();
    if (phase === "idle" || phase === "cloning") return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, STATE_SNAPSHOT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    const clone = this.clonePath();
    if (!clone) return;
    const { phase } = this.ctx();
    if (phase === "idle" || phase === "cloning") return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    this.again = false;
    try {
      const c = this.ctx();
      const snapshot = buildStateSnapshot({
        writtenAt: Date.now(),
        phase: c.phase,
        round: c.round,
        runBootedAt: c.runBootedAt,
        runStartedAt: c.runStartedAt,
        activeElapsedMs: c.tickAccumulatorActiveElapsedMs,
        config: c.active,
        contract: c.contract ? c.cloneContract(c.contract) : undefined,
        board: c.boardSnapshot(),
        perAgent: c.buildPerAgentStats(),
        staleEventCount: c.staleEventCount,
        auditInvocations: c.auditInvocations,
        agentRoster: c.agentRoster.map((a) => ({
          agentId: a.id,
          agentIndex: a.index,
        })),
        terminationReason: c.terminationReason,
        completionDetail: c.completionDetail,
        currentTier: c.currentTier > 0 ? c.currentTier : undefined,
        tiersCompleted: c.tiersCompleted,
        tierHistory: c.tierHistory.length > 0 ? c.tierHistory.slice() : undefined,
      });
      const outPath = path.join(clone, "blackboard-state.json");
      await writeFileAtomic(outPath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("blackboard-state write failed:", msg);
    } finally {
      this.inFlight = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}