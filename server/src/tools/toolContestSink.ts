/**
 * Run-scoped sink for contestable tool denials — transcript + WS + clone logs.
 * Registered by Orchestrator when a run becomes active so ToolDispatcher
 * (no runner reference) can still surface contests to operators.
 */

import type { TranscriptEntrySummary } from "@ollama-swarm/shared/transcriptEntrySummary";
import type { DeliberationSink } from "../swarm/deliberation/deliberationTypes.js";

export interface ToolContestRunSink {
  clonePath?: string;
  appendSystem?: (msg: string, summary?: TranscriptEntrySummary) => void;
  emit?: (event: { type: string; [key: string]: unknown }) => void;
  logDiag?: (entry: Record<string, unknown>) => void;
}

const byRun = new Map<string, ToolContestRunSink>();

export function setToolContestRunSink(runId: string, sink: ToolContestRunSink): void {
  const id = runId?.trim();
  if (!id) return;
  byRun.set(id, sink);
}

export function clearToolContestRunSink(runId?: string): void {
  if (runId?.trim()) byRun.delete(runId.trim());
  else byRun.clear();
}

export function getToolContestRunSink(runId: string | undefined | null): ToolContestRunSink | undefined {
  const id = runId?.trim();
  if (!id) return undefined;
  return byRun.get(id);
}

/** Merge call-site sink with the run registry (registry fills gaps). */
export function mergeToolContestSink(
  runId: string | undefined,
  partial?: DeliberationSink,
): DeliberationSink {
  const reg = getToolContestRunSink(runId);
  return {
    runId: runId || partial?.runId,
    clonePath: partial?.clonePath ?? reg?.clonePath,
    appendSystem: (msg) => {
      // Prefer structured transcript via publishToolContestEvent; plain
      // deliberation lines are optional noise — only call partial if set.
      partial?.appendSystem?.(msg);
    },
    emit: (event) => {
      try {
        partial?.emit?.(event);
      } catch {
        /* */
      }
      try {
        reg?.emit?.(event as { type: string; [key: string]: unknown });
      } catch {
        /* */
      }
    },
    logDiag: (entry) => {
      try {
        partial?.logDiag?.(entry);
      } catch {
        /* */
      }
      try {
        reg?.logDiag?.(entry);
      } catch {
        /* */
      }
    },
  };
}
