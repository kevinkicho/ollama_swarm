// First slice of V2 Step 6c (E2 in active-work.md). Subscribes the web
// to GET /api/v2/event-log/runs in a parallel-track shape — does NOT
// replace the WebSocket-snapshot state today. The eventual cutover
// (UI rebuilds state via deriveRunState from the JSONL stream)
// builds on this; landing the data path first means the UI can opt
// into event-log-derived signals piecemeal instead of all-or-nothing.
//
// Polls every 10s by default. Reuses the cache + subscriber pattern
// from useAvailableModels / useProviders so multiple consumers share
// one fetch. Returns parsed shape that mirrors what EventLogReaderV2
// produces server-side; UI panels can read this without re-parsing.

import { useEffect, useState } from "react";

export interface EventLogRun {
  derived: {
    errors: string[];
    transcriptCount: number;
    agentStateUpdates: number;
    hasSummary: boolean;
    runId?: string;
    preset?: string;
    // EventLogPanel.tsx already consumes this shape — kept in sync.
    startedAt?: number;
    finishedAt?: number;
    finalPhase?: string;
  };
  recordCount: number;
  isSessionBoundary: boolean;
}

export interface EventLogStreamState {
  runs: readonly EventLogRun[];
  malformed: number;
  source: string | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

const DEFAULT_STATE: EventLogStreamState = {
  runs: [],
  malformed: 0,
  source: null,
  loading: true,
  error: null,
  lastFetchedAt: null,
};

const POLL_MS = 10_000;

let cache: EventLogStreamState | null = null;
let inflight: Promise<EventLogStreamState> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(s: EventLogStreamState) => void>();

function notify(state: EventLogStreamState): void {
  cache = state;
  for (const fn of subscribers) fn(state);
}

async function fetchOnce(): Promise<EventLogStreamState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch("/api/v2/event-log/runs?limit=200");
      if (!r.ok) {
        const next: EventLogStreamState = {
          ...(cache ?? DEFAULT_STATE),
          loading: false,
          error: `HTTP ${r.status}`,
          lastFetchedAt: Date.now(),
        };
        notify(next);
        return next;
      }
      const body = (await r.json()) as {
        runs?: EventLogRun[];
        malformed?: number;
        source?: string;
      };
      const next: EventLogStreamState = {
        runs: body.runs ?? [],
        malformed: body.malformed ?? 0,
        source: body.source ?? null,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      };
      notify(next);
      return next;
    } catch (err) {
      const next: EventLogStreamState = {
        ...(cache ?? DEFAULT_STATE),
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        lastFetchedAt: Date.now(),
      };
      notify(next);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (subscribers.size === 0) return;
    void fetchOnce();
  }, POLL_MS);
  // Don't keep the process alive in test environments
  if (typeof pollTimer === "object" && pollTimer && "unref" in pollTimer) {
    (pollTimer as unknown as { unref?: () => void }).unref?.();
  }
}

function tearDownIfIdle(): void {
  if (subscribers.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useEventLogStream(): EventLogStreamState {
  const [state, setState] = useState<EventLogStreamState>(() => cache ?? DEFAULT_STATE);
  useEffect(() => {
    subscribers.add(setState);
    if (!cache) void fetchOnce();
    ensurePolling();
    return () => {
      subscribers.delete(setState);
      tearDownIfIdle();
    };
  }, []);
  return state;
}

// Test seam: lets unit tests preload a known cache + observe notifications
// without spinning up a real fetch. NOT used by production code.
export const __testing__ = {
  reset(): void {
    cache = null;
    inflight = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    subscribers.clear();
  },
  getCache(): EventLogStreamState | null {
    return cache;
  },
  setCache(s: EventLogStreamState): void {
    cache = s;
  },
};
