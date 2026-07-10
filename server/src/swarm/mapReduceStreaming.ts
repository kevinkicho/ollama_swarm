// Streaming map-reduce scheduler — extracted from MapReduceRunner.runStreamingMapReduce.

import type { Agent } from "../services/AgentManager.js";
import type { TranscriptEntry } from "../types.js";

export interface StreamingMapReduceHost {
  getStopping: () => boolean;
  appendSystem: (text: string) => void;
  runMapperTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    slice: readonly string[],
    seedSnapshot: readonly TranscriptEntry[],
    userDirective?: string,
    reframing?: string,
  ) => Promise<void>;
  runReducerTurn: (
    agent: Agent,
    round: number,
    totalRounds: number,
    isFinal?: true,
    userDirective?: string,
  ) => Promise<void>;
}

/**
 * Event-driven streaming reducer: fires intermediate reducer turns at
 * fractional thresholds (1/3, 2/3, N of mapper completions) while mappers
 * stay parallel.
 */
export async function runStreamingMapReduce(
  host: StreamingMapReduceHost,
  input: {
    mappers: Agent[];
    reducer: Agent;
    slices: string[][];
    reframingsThisCycle: Map<number, string>;
    seedSnapshot: readonly TranscriptEntry[];
    round: number;
    totalRounds: number;
    userDirective?: string;
  },
): Promise<void> {
  const {
    mappers,
    reducer,
    slices,
    reframingsThisCycle,
    seedSnapshot,
    round,
    totalRounds,
    userDirective,
  } = input;
  const N = mappers.length;
  const thresholds = [
    Math.max(1, Math.ceil(N / 3)),
    Math.max(2, Math.ceil((2 * N) / 3)),
    N,
  ].filter((t, i, a) => a.indexOf(t) === i);
  let completedCount = 0;
  let resolveNext: (() => void) | null = null;
  let pendingNotice: Promise<void> = new Promise((res) => {
    resolveNext = res;
  });
  const notifyCompletion = () => {
    completedCount++;
    const r = resolveNext;
    resolveNext = null;
    const next = new Promise<void>((res) => {
      resolveNext = res;
    });
    pendingNotice = next;
    r?.();
  };
  const mapperPromises = mappers.map((m, i) => {
    const mySlice = slices[i] ?? [];
    const reframing = reframingsThisCycle.get(m.index);
    const startDelay = i * 150;
    return new Promise<void>((res) => {
      setTimeout(() => {
        if (host.getStopping()) {
          notifyCompletion();
          res();
          return;
        }
        host
          .runMapperTurn(
            m,
            round,
            totalRounds,
            mySlice,
            seedSnapshot,
            userDirective,
            reframing,
          )
          .catch(() => {
            // mapper-turn errors already log inside runMapperTurn
          })
          .finally(() => {
            notifyCompletion();
            res();
          });
      }, startDelay);
    });
  });

  let nextThresholdIdx = 0;
  while (nextThresholdIdx < thresholds.length) {
    const target = thresholds[nextThresholdIdx]!;
    while (completedCount < target && !host.getStopping()) {
      await pendingNotice;
    }
    if (host.getStopping()) break;
    const isFinalThreshold = nextThresholdIdx === thresholds.length - 1;
    host.appendSystem(
      `[T199 streaming reducer] firing reduce at ${completedCount}/${N} mappers complete (threshold ${nextThresholdIdx + 1}/${thresholds.length}${isFinalThreshold ? ", FINAL" : ""}).`,
    );
    await host.runReducerTurn(
      reducer,
      round,
      totalRounds,
      isFinalThreshold || undefined,
      userDirective,
    );
    nextThresholdIdx++;
  }
  await Promise.all(mapperPromises);
}
