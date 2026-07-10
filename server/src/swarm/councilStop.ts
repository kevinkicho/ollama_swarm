// Council hard-stop / soft-drain / close-out — extracted from CouncilRunner.

import type { AgentManager } from "../services/AgentManager.js";
import type { SwarmPhase } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TodoQueue } from "./blackboard/TodoQueue.js";
import { formatPortReleaseLine } from "./runSummary.js";
import {
  councilRunIdShort,
  persistCouncilPendingTodos,
} from "./councilExecutionResume.js";

export interface CouncilStopHost {
  getSummaryWritten: () => boolean;
  getPhase: () => SwarmPhase;
  setPhase: (p: SwarmPhase) => void;
  getStopInFlight: () => Promise<void> | null;
  setStopInFlight: (p: Promise<void> | null) => void;
  setTranscriptFrozen: (v: boolean) => void;
  setStopping: (v: boolean) => void;
  getStopping: () => boolean;
  setStateStopping: (v: boolean) => void;
  hasState: () => boolean;
  manager: AgentManager;
  getStopAbortController: () => AbortController | undefined;
  getDrainRequested: () => boolean;
  setDrainRequested: (v: boolean) => void;
  appendSystem: (text: string) => void;
  getTodoCounts: () => { inProgress: number; pending: number } | undefined;
  anyAgentThinking: () => boolean;
  getDrainResolve: () => (() => void) | undefined;
  setDrainResolve: (fn: (() => void) | undefined) => void;
  getWorkerDrainPromise: () => Promise<void> | null;
  getLoopPromise: () => Promise<void> | null;
  getActive: () => RunConfig | undefined;
  getTodoQueue: () => TodoQueue | undefined;
  writeSummary: (cfg: RunConfig) => Promise<void>;
  superAppendSystem: (text: string) => void;
  stopCapWatchdog: () => void;
}

export function enterImmediateShutdown(host: CouncilStopHost): void {
  host.setTranscriptFrozen(true);
  host.setStopping(true);
  if (host.hasState()) host.setStateStopping(true);
  host.manager.beginRunShutdown();
  try {
    host.getStopAbortController()?.abort(new Error("user stop"));
  } catch {
    // best-effort
  }
}

export async function waitForAgentsIdle(
  host: CouncilStopHost,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (host.anyAgentThinking() && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 500));
  }
}

export async function councilStop(host: CouncilStopHost): Promise<void> {
  if (host.getStopInFlight()) return host.getStopInFlight()!;
  enterImmediateShutdown(host);
  const p = awaitLoopThenCloseOut(host, { immediate: true });
  host.setStopInFlight(p);
  return p;
}

/**
 * Soft drain: mark draining and return promptly so HTTP /drain can release.
 * Wait + close-out runs in the background. Hard stop() can still escalate
 * immediately (enterImmediateShutdown unblocks waiters via drainResolve).
 */
export async function councilDrain(host: CouncilStopHost): Promise<void> {
  if (host.getStopInFlight()) return host.getStopInFlight()!;
  if (host.getPhase() === "stopped" || host.getPhase() === "completed") return;
  // Already soft-draining — idempotent no-op (watcher/background continues).
  if (host.getDrainRequested() || host.getPhase() === "draining") return;

  const q = host.getTodoCounts();
  const inFlight = (q?.inProgress ?? 0) + (q?.pending ?? 0);
  const phase = host.getPhase();
  const discussionPhase = phase === "discussing" || phase === "seeding";
  const agentsThinking = host.anyAgentThinking();

  if (inFlight === 0 && phase !== "executing") {
    if (discussionPhase && agentsThinking) {
      host.setDrainRequested(true);
      host.setPhase("draining");
      host.appendSystem(
        "[drain] Finishing in-flight discussion turn(s), then stopping (no new claims). " +
          "Press Stop to escalate immediately.",
      );
      void finishCouncilDrainInBackground(host, { mode: "discussion" });
      return;
    }
    host.appendSystem(
      "Drain not applicable (no in-flight execution todos — use Stop for immediate exit). Stopping immediately.",
    );
    return councilStop(host);
  }

  host.setDrainRequested(true);
  host.setPhase("draining");
  host.appendSystem(
    `[drain] Soft stop — finishing in-flight work (${inFlight} todo(s)), no new claims. ` +
      "Press Stop to escalate immediately.",
  );
  void finishCouncilDrainInBackground(host, { mode: "execution" });
}

async function finishCouncilDrainInBackground(
  host: CouncilStopHost,
  opts: { mode: "discussion" | "execution" },
): Promise<void> {
  const DRAIN_TIMEOUT = 180_000;
  try {
    if (opts.mode === "discussion") {
      await waitForAgentsIdle(host, DRAIN_TIMEOUT);
    } else {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          host.appendSystem("[drain] Timeout waiting for workers — forcing stop.");
          resolve();
        }, DRAIN_TIMEOUT);
        const origResolve = host.getDrainResolve();
        host.setDrainResolve(() => {
          clearTimeout(timer);
          resolve();
          origResolve?.();
        });
      });
    }
  } catch {
    // best-effort — still close out below unless hard stop already finished
  }

  // Hard stop already took over.
  if (host.getStopInFlight()) return;
  if (host.getPhase() === "stopped" || host.getPhase() === "completed") return;
  if (host.getStopping() && host.getPhase() === "stopping") return;

  host.setStopping(true);
  if (host.hasState()) host.setStateStopping(true);
  const p = awaitLoopThenCloseOut(host, { immediate: true });
  host.setStopInFlight(p);
  await p.catch(() => {});
}

export async function awaitLoopThenCloseOut(
  host: CouncilStopHost,
  opts: { immediate: boolean },
): Promise<void> {
  if (opts.immediate && host.getWorkerDrainPromise()) {
    await Promise.race([
      host.getWorkerDrainPromise()!.catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 45_000)),
    ]);
  }
  if (host.getLoopPromise()) {
    const loopCapMs = opts.immediate ? 10_000 : 120_000;
    await Promise.race([
      host.getLoopPromise()!.catch(() => {}),
      new Promise<void>((r) => setTimeout(r, loopCapMs)),
    ]);
  }
  await closeOutStopped(host, opts);
}

export async function closeOutStopped(
  host: CouncilStopHost,
  opts: { immediate: boolean },
): Promise<void> {
  if (
    host.getSummaryWritten() &&
    (host.getPhase() === "stopped" || host.getPhase() === "completed")
  ) {
    return;
  }

  if (opts.immediate) {
    enterImmediateShutdown(host);
  } else {
    host.setStopping(true);
    if (host.hasState()) host.setStateStopping(true);
  }
  host.setPhase("stopping");
  host.stopCapWatchdog();

  const unblockDrain = host.getDrainResolve();
  host.setDrainResolve(undefined);
  unblockDrain?.();

  const cfg = host.getActive();
  if (cfg?.runId) {
    const queue = host.getTodoQueue();
    if (queue) {
      const n = queue.counts().pending + queue.counts().inProgress;
      if (n > 0) {
        const clonePath = cfg.localPath ?? "";
        if (clonePath) {
          persistCouncilPendingTodos(clonePath, cfg.runId, queue.list());
          host.appendSystem(
            `[resume] Saved ${n} pending execution todo(s) for run ${councilRunIdShort(cfg.runId)}.`,
          );
        }
      }
    }
  }
  if (cfg) {
    await host.writeSummary(cfg);
  }

  host.setTranscriptFrozen(true);
  const killResult = await host.manager.killAll();
  host.superAppendSystem(formatPortReleaseLine(killResult));
  host.setPhase("stopped");
}

export async function ensureTerminalCloseOut(host: CouncilStopHost): Promise<void> {
  if (host.getSummaryWritten()) return;
  if (host.getPhase() === "stopped" || host.getPhase() === "completed") return;
  if (host.getStopInFlight()) {
    await host.getStopInFlight()!.catch(() => {});
    return;
  }
  const p = closeOutStopped(host, { immediate: true });
  host.setStopInFlight(p);
  await p.catch(() => {});
}
