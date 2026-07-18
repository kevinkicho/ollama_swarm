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

/**
 * Signal hard stop (abort + stopping flags) without freezing the transcript.
 * Terminal system lines (resume save, summary banner, timeout notes) must still
 * land; freeze only immediately before killAll in closeOutStopped.
 */
export function enterImmediateShutdown(host: CouncilStopHost): void {
  host.setStopping(true);
  if (host.hasState()) host.setStateStopping(true);
  host.manager.beginRunShutdown();
  try {
    host.getStopAbortController()?.abort(new Error("user stop"));
  } catch {
    // best-effort
  }
}

/** Install a single-flight promise synchronously so concurrent stop/drain join. */
function installStopInFlight(
  host: CouncilStopHost,
  work: () => Promise<void>,
): Promise<void> {
  const existing = host.getStopInFlight();
  if (existing) return existing;
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  // Create + install *before* starting work so a concurrent caller joins.
  const p = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  host.setStopInFlight(p);
  void work().then(resolve, reject).finally(() => {
    if (host.getStopInFlight() === p) {
      host.setStopInFlight(null);
    }
  });
  return p;
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
  // Single-flight: concurrent stop/drain share one close-out promise.
  // Install the promise *before* any await so two concurrent stop() calls
  // cannot both enter awaitLoopThenCloseOut (TOCTOU).
  return installStopInFlight(host, async () => {
    enterImmediateShutdown(host);
    await awaitLoopThenCloseOut(host, { immediate: true });
  });
}

/**
 * Soft drain: mark draining and return promptly so HTTP /drain can release.
 * Wait + close-out runs in the background. Hard stop() can still escalate
 * immediately (enterImmediateShutdown unblocks waiters via drainResolve).
 */
export async function councilDrain(host: CouncilStopHost): Promise<void> {
  // Join hard-stop close-out if already in flight (do not start a second path).
  const inflight = host.getStopInFlight();
  if (inflight) return inflight;
  if (host.getPhase() === "stopped" || host.getPhase() === "completed") return;
  // Already soft-draining — idempotent no-op (watcher/background continues).
  if (host.getDrainRequested() || host.getPhase() === "draining") return;

  const q = host.getTodoCounts();
  const inFlight = (q?.inProgress ?? 0) + (q?.pending ?? 0);
  const phase = host.getPhase();
  const discussionPhase = phase === "discussing" || phase === "seeding";
  const agentsThinking = host.anyAgentThinking();
  // Empty queue: hard-stop even if phase is still "executing" (workers finished,
  // phase lag). Previously waited full soft-drain timeout for a drainResolve
  // that never fires when drainTodos already exited.
  if (inFlight === 0) {
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
    // Workers still draining this cycle — join their promise instead of 180s sleep.
    const workerDrain = host.getWorkerDrainPromise();
    if (workerDrain && phase === "executing") {
      host.setDrainRequested(true);
      host.setPhase("draining");
      host.appendSystem(
        "[drain] Soft stop — waiting for in-flight execution workers to finish (queue empty).",
      );
      void (async () => {
        try {
          await Promise.race([
            workerDrain.catch(() => {}),
            new Promise<void>((r) => setTimeout(r, 180_000)),
          ]);
        } finally {
          if (!host.getStopInFlight()) {
            await councilStop(host);
          }
        }
      })();
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

  await installStopInFlight(host, async () => {
    host.setStopping(true);
    if (host.hasState()) host.setStateStopping(true);
    await awaitLoopThenCloseOut(host, { immediate: true });
  }).catch(() => {});
}

/** Hard-stop wait for in-flight execution workers before killAll. */
export const HARD_STOP_WORKER_WAIT_MS = 45_000;
/** Hard-stop wait for main discussion loop to observe stopping. */
export const HARD_STOP_LOOP_WAIT_MS = 10_000;

export async function awaitLoopThenCloseOut(
  host: CouncilStopHost,
  opts: { immediate: boolean },
): Promise<void> {
  if (opts.immediate && host.getWorkerDrainPromise()) {
    const workerDone = await Promise.race([
      host.getWorkerDrainPromise()!.then(() => "done" as const).catch(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), HARD_STOP_WORKER_WAIT_MS)),
    ]);
    if (workerDone === "timeout") {
      // Workers hung past grace — force session abort again, then killAll in closeOut.
      try {
        host.appendSystem(
          `[stop] Execution workers did not exit within ${Math.round(HARD_STOP_WORKER_WAIT_MS / 1000)}s — forcing abort before killAll.`,
        );
      } catch {
        /* transcript may already be frozen */
      }
      try {
        host.manager.beginRunShutdown();
      } catch {
        // best-effort
      }
      try {
        host.getStopAbortController()?.abort(new Error("hard-stop worker wait exceeded"));
      } catch {
        // best-effort
      }
    }
  }
  if (host.getLoopPromise()) {
    const loopCapMs = opts.immediate ? HARD_STOP_LOOP_WAIT_MS : 120_000;
    const loopDone = await Promise.race([
      host.getLoopPromise()!.then(() => "done" as const).catch(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), loopCapMs)),
    ]);
    if (opts.immediate && loopDone === "timeout") {
      try {
        host.appendSystem(
          `[stop] Main loop did not settle within ${Math.round(loopCapMs / 1000)}s — proceeding to force killAll.`,
        );
      } catch {
        /* frozen transcript */
      }
      try {
        host.manager.beginRunShutdown();
      } catch {
        // best-effort
      }
    }
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
  await installStopInFlight(host, () => closeOutStopped(host, { immediate: true })).catch(
    () => {},
  );
}
