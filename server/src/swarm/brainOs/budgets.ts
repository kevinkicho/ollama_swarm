import {
  emptyBrainOsMetrics,
  type BrainOsRunMetrics,
} from "@ollama-swarm/shared/brainOs";

/** Per-run Brain OS budget ledger. */
export class BrainOsBudgetLedger {
  readonly metrics: BrainOsRunMetrics = emptyBrainOsMetrics();
  private helpersSpawned = 0;
  private concurrent = 0;

  constructor(
    private readonly caps: {
      maxHelpersPerRun: number;
      maxConcurrentHelpers: number;
    } = { maxHelpersPerRun: 8, maxConcurrentHelpers: 2 },
  ) {}

  canSpawn(): boolean {
    return (
      this.helpersSpawned < this.caps.maxHelpersPerRun
      && this.concurrent < this.caps.maxConcurrentHelpers
    );
  }

  beginHelper(): boolean {
    if (!this.canSpawn()) return false;
    this.helpersSpawned += 1;
    this.concurrent += 1;
    this.metrics.helpersSpawned += 1;
    return true;
  }

  endHelper(): void {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }

  recordDispatch(
    status: "resolved" | "partial" | "blocked" | "needs_human",
    usage?: { tokensIn?: number; tokensOut?: number; wallMs: number },
  ): void {
    this.metrics.dispatches += 1;
    if (status === "resolved") this.metrics.resolved += 1;
    else if (status === "partial") this.metrics.partial += 1;
    else if (status === "blocked") this.metrics.blocked += 1;
    else this.metrics.needsHuman += 1;
    if (usage) {
      this.metrics.tokensIn += usage.tokensIn ?? 0;
      this.metrics.tokensOut += usage.tokensOut ?? 0;
      this.metrics.wallMs += usage.wallMs ?? 0;
    }
  }

  recordChild(): void {
    this.metrics.childDispatches += 1;
  }

  recordEffect(ok: boolean): void {
    if (ok) this.metrics.effectsApplied += 1;
    else this.metrics.effectsRejected += 1;
  }

  snapshot(): BrainOsRunMetrics {
    return { ...this.metrics };
  }
}
