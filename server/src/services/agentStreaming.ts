/**
 * Throttled per-agent streaming text dispatch for AgentManager.
 * Coalesces high-frequency chunk updates to ~STREAMING_THROTTLE_MS.
 *
 * WS payload cap (9f449937): without a cap, each throttled emit shipped
 * the full cumulative buffer (grew to ~300k) over the socket and into
 * debug.jsonl (~50MB per 200-line slice). Think-guard still sees the
 * full text via wrapOnChunk; only the UI/wire payload is truncated.
 */

export const STREAMING_THROTTLE_MS = 33;
/** Max chars of cumulative text on each agent_streaming WS event. */
export const STREAMING_WS_MAX_CHARS = 48_000;

/** Truncate a cumulative stream for wire/UI without losing head+tail context. */
export function truncateStreamingPayload(text: string, maxChars = STREAMING_WS_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 80;
  return (
    text.slice(0, head) +
    `\n…[stream truncated for UI/wire: ${text.length.toLocaleString()} chars total]…\n` +
    text.slice(-Math.max(0, tail))
  );
}

export interface StreamingEmitPayload {
  agentId: string;
  agentIndex: number;
  text: string;
}

export interface StreamingThrottleOpts {
  throttleMs?: number;
  /** Return true to drop emits (run shut down / agent suppressed). */
  shouldSuppress?: (agentId: string) => boolean;
  onStreaming: (payload: StreamingEmitPayload) => void;
  onStreamingEnd?: (agentId: string) => void;
}

/**
 * Owns partial-stream buffers + trailing-edge flush timers.
 * AgentManager owns agent lifecycle; this only schedules UI text emits.
 */
export class StreamingTextThrottle {
  private readonly throttleMs: number;
  private readonly partialStreams = new Map<string, { text: string; updatedAt: number }>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private readonly latestText = new Map<string, string>();
  private readonly agentIndex = new Map<string, number>();

  constructor(private readonly opts: StreamingThrottleOpts) {
    this.throttleMs = opts.throttleMs ?? STREAMING_THROTTLE_MS;
  }

  getPartial(agentId: string): { text: string; updatedAt: number } | undefined {
    return this.partialStreams.get(agentId);
  }

  getAllPartials(): Map<string, { text: string; updatedAt: number }> {
    return this.partialStreams;
  }

  record(agentId: string, agentIndex: number, cumulativeText: string): void {
    if (this.opts.shouldSuppress?.(agentId)) return;
    this.agentIndex.set(agentId, agentIndex);
    const isFirstByte = !this.partialStreams.has(agentId);
    this.partialStreams.set(agentId, { text: cumulativeText, updatedAt: Date.now() });
    this.scheduleFlush(agentId, cumulativeText, isFirstByte);
  }

  markDone(agentId: string, opts?: { preservePartial?: boolean }): void {
    this.flushNow(agentId);
    this.opts.onStreamingEnd?.(agentId);
    if (!opts?.preservePartial) {
      this.partialStreams.delete(agentId);
    }
    const t = this.flushTimers.get(agentId);
    if (t) clearTimeout(t);
    this.flushTimers.delete(agentId);
    this.latestText.delete(agentId);
  }

  clearAgent(agentId: string): void {
    this.partialStreams.delete(agentId);
    const t = this.flushTimers.get(agentId);
    if (t) clearTimeout(t);
    this.flushTimers.delete(agentId);
    this.latestText.delete(agentId);
    this.agentIndex.delete(agentId);
  }

  clearAll(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    this.latestText.clear();
    this.partialStreams.clear();
    this.agentIndex.clear();
  }

  private scheduleFlush(agentId: string, text: string, flushNow = false): void {
    this.latestText.set(agentId, text);
    if (flushNow) this.emit(agentId);
    if (this.flushTimers.has(agentId)) return;
    this.flushTimers.set(
      agentId,
      setTimeout(() => {
        this.flushTimers.delete(agentId);
        const latest = this.latestText.get(agentId);
        if (latest === undefined) return;
        this.emit(agentId, latest);
      }, this.throttleMs),
    );
  }

  private flushNow(agentId: string): void {
    const timer = this.flushTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(agentId);
    }
    const latest = this.latestText.get(agentId);
    this.latestText.delete(agentId);
    this.emit(agentId, latest);
  }

  private emit(agentId: string, text?: string): void {
    const latest = text ?? this.latestText.get(agentId);
    if (latest === undefined) return;
    if (this.opts.shouldSuppress?.(agentId)) return;
    const agentIndex = this.agentIndex.get(agentId) ?? 0;
    this.opts.onStreaming({
      agentId,
      agentIndex,
      text: truncateStreamingPayload(latest),
    });
  }
}
