// PR-7/9: multi-provider capacity layer — single entry for LLM calls
// with per-provider rate limits, circuit breakers, fair scheduling,
// and per-run attribution.

import { detectProvider, type Provider } from "@ollama-swarm/shared/providers";
import { config } from "../config.js";
import { pickProvider } from "./pickProvider.js";
import type { ChatOpts, ChatResult } from "./SessionProvider.js";


export type CircuitState = "closed" | "open" | "half-open";

export interface ProviderHealthEntry {
  provider: Provider;
  circuit: CircuitState;
  failures: number;
  rateLimitPerSec: number;
  headroom: number;
  queueDepth: number;
  lastFailureAt?: number;
}

interface CircuitBreaker {
  failures: number;
  state: CircuitState;
  openedAt?: number;
  lastFailureAt?: number;
}

interface QueuedJob {
  runId?: string;
  provider: Provider;
  priority: number;
  submittedAt: number;
  opts: GatewayChatOpts;
  resolve: (r: ChatResult) => void;
  reject: (e: unknown) => void;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
    this.lastRefill = now;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  headroom(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

export interface GatewayChatOpts extends Omit<ChatOpts, "model"> {
  /** Bare or prefixed model string for provider routing. */
  modelString: string;
  runId?: string;
  /** Lower = higher priority. User runs default 0; brain-initiated use higher to protect user work for stability. */
  priority?: number;
  brainInitiated?: boolean;
}

class ProviderGatewayImpl {
  private readonly buckets = new Map<Provider, TokenBucket>();
  private readonly circuits = new Map<Provider, CircuitBreaker>();
  private readonly queues = new Map<Provider, QueuedJob[]>();
  private readonly draining = new Set<Provider>();

  private readonly MAX_QUEUE_PER_PROVIDER = 64; // stability bound under overload (Brain low-pri jobs can be dropped)

  constructor() {
    for (const p of ["ollama", "ollama-cloud", "anthropic", "openai", "opencode"] as Provider[]) {
      this.buckets.set(p, new TokenBucket(this.rateFor(p), this.rateFor(p) * 2));
      this.circuits.set(p, { failures: 0, state: "closed" });
      this.queues.set(p, []);
    }
  }

  private rateFor(provider: Provider): number {
    switch (provider) {
      case "ollama":
      case "ollama-cloud":
        return config.PROVIDER_RATE_LIMIT_OLLAMA;
      case "anthropic":
        return config.PROVIDER_RATE_LIMIT_ANTHROPIC;
      case "openai":
        return config.PROVIDER_RATE_LIMIT_OPENAI;
      case "opencode":
        return config.PROVIDER_RATE_LIMIT_OPENCODE;
    }
  }

  private circuitFor(provider: Provider): CircuitBreaker {
    return this.circuits.get(provider)!;
  }

  private recordFailure(provider: Provider): void {
    const c = this.circuitFor(provider);
    c.failures += 1;
    c.lastFailureAt = Date.now();
    if (c.failures >= config.PROVIDER_CIRCUIT_BREAKER_THRESHOLD) {
      c.state = "open";
      c.openedAt = Date.now();
    }
  }

  private recordSuccess(provider: Provider): void {
    const c = this.circuitFor(provider);
    c.failures = 0;
    c.state = "closed";
    c.openedAt = undefined;
  }

  private circuitAllows(provider: Provider): boolean {
    const c = this.circuitFor(provider);
    if (c.state === "closed") return true;
    if (c.state === "open") {
      const elapsed = Date.now() - (c.openedAt ?? 0);
      if (elapsed >= config.PROVIDER_CIRCUIT_BREAKER_COOLDOWN_MS) {
        c.state = "half-open";
        return true;
      }
      return false;
    }
    return true;
  }

  getHealth(): Record<Provider, ProviderHealthEntry> {
    const out = {} as Record<Provider, ProviderHealthEntry>;
    for (const provider of ["ollama", "ollama-cloud", "anthropic", "openai", "opencode"] as Provider[]) {
      const bucket = this.buckets.get(provider)!;
      const circuit = this.circuitFor(provider);
      out[provider] = {
        provider,
        circuit: circuit.state,
        failures: circuit.failures,
        rateLimitPerSec: this.rateFor(provider),
        headroom: bucket.headroom(),
        queueDepth: (this.queues.get(provider) ?? []).length,
        lastFailureAt: circuit.lastFailureAt,
      };
    }
    return out;
  }

  getQueueDepth(runId?: string): number {
    let n = 0;
    for (const q of this.queues.values()) {
      for (const job of q) {
        if (!runId || job.runId === runId) n += 1;
      }
    }
    return n;
  }

  async chat(opts: GatewayChatOpts): Promise<ChatResult> {
    if (!config.PROVIDER_GATEWAY) {
      const { provider, modelId } = pickProvider(opts.modelString);
      return provider.chat({ ...opts, model: modelId });
    }
    const provider = detectProvider(opts.modelString);
    return new Promise<ChatResult>((resolve, reject) => {
      const q = this.queues.get(provider)!;
      // Bounded queue for stability under overload (Brain low-pri jobs dropped first).
      if (q.length >= this.MAX_QUEUE_PER_PROVIDER) {
        const lowPrioIdx = q.findIndex(j => (j.priority ?? 0) > 0);
        const toDrop = lowPrioIdx >= 0 ? q.splice(lowPrioIdx, 1)[0] : q.shift();
        if (toDrop) {
          toDrop.reject(new Error("provider-gateway: queue full (stability backpressure)"));
        }
      }

      const job: QueuedJob = {
        runId: opts.runId,
        provider,
        priority: opts.priority ?? (opts.brainInitiated ? 5 : 0),
        submittedAt: Date.now(),
        opts,
        resolve,
        reject,
      };
      q.push(job);
      void this.drainQueue(provider);
    });
  }

  private pickNextJob(provider: Provider): QueuedJob | undefined {
    const q = this.queues.get(provider)!;
    if (q.length === 0) return undefined;
    if (!config.SWARM_FAIR_SCHEDULING) {
      return q.shift();
    }
    // Weighted fair: group by runId, pick the group with oldest head job.
    const byRun = new Map<string, QueuedJob[]>();
    for (const job of q) {
      const key = job.runId ?? "__global__";
      const list = byRun.get(key) ?? [];
      list.push(job);
      byRun.set(key, list);
    }
    let bestKey: string | undefined;
    let bestHead: QueuedJob | undefined;
    for (const [key, jobs] of byRun) {
      jobs.sort((a, b) => a.priority - b.priority || a.submittedAt - b.submittedAt);
      const head = jobs[0];
      if (!bestHead || head.submittedAt < bestHead.submittedAt) {
        bestHead = head;
        bestKey = key;
      }
    }
    if (!bestKey) return undefined;
    const idx = q.findIndex((j) => (j.runId ?? "__global__") === bestKey && j === bestHead);
    if (idx < 0) return q.shift();
    return q.splice(idx, 1)[0];
  }

  private async drainQueue(provider: Provider): Promise<void> {
    if (this.draining.has(provider)) return;
    this.draining.add(provider);
    try {
      while (true) {
        const bucket = this.buckets.get(provider)!;
        if (!bucket.tryTake()) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        if (!this.circuitAllows(provider)) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const job = this.pickNextJob(provider);
        if (!job) break;
        try {
          const { provider: session, modelId } = pickProvider(job.opts.modelString);
          const t0 = Date.now();
          const { modelString: _ms, priority: _pri, brainInitiated: _bi, ...chatOpts } = job.opts;
          const result = await session.chat({ ...chatOpts, model: modelId, runId: job.runId, brainInitiated: job.runId ? (job.opts as any).brainInitiated : undefined });
          // Usage is recorded by promptWithRetry.recordChatUsage (single site)
          // to avoid double-counting when the gateway is enabled.
          void t0; // duration measured by caller
          this.recordSuccess(provider);
          job.resolve(result);
        } catch (err) {
          this.recordFailure(provider);
          job.reject(err);
        }
      }
    } finally {
      this.draining.delete(provider);
      const remaining = this.queues.get(provider)!.length;
      if (remaining > 0) void this.drainQueue(provider);
    }
  }
}

export const providerGateway = new ProviderGatewayImpl();