import { runBrainAnalysis, type BrainAnalysisResult } from "./brainOverseer.js";
import { createRunProvisioner, type RunProvisioner } from "./provisioner.js";
import { createBrainQueue, type BrainQueue } from "./brainQueue.js";
import type { InteractionTracker } from "./interactionTracker.js";
import type { ExceptionCollector } from "./exceptionCollector.js";
import {
  readProposals,
  updateProposalStatus,
  appendProposal,
  type PersistedProposal,
} from "./proposalStore.js";
import { tokenTracker } from "../../../services/ollamaProxy.js";

export interface BrainActivityEntry {
  timestamp: number;
  type: "analysis" | "proposal" | "health" | "error" | "provision"; // removed "patch" — no more system patching
  title: string;
  detail?: string;
  status?: "success" | "pending" | "failed";
}

export interface BrainService {
  analyzeRun(
    interactionTracker: InteractionTracker,
    exceptionCollector: ExceptionCollector,
    clonePath: string,
    runId: string,
    promptFn?: (prompt: string, model: string, maxTokens: number, timeoutMs: number) => Promise<string>,
    model?: string,
  ): Promise<BrainAnalysisResult>;
  getProvisioner(): RunProvisioner;
  getQueue(): BrainQueue;
  getClonePath(): string | undefined;
  registerClonePath(clonePath: string): void;
  getAllProposals(clonePath?: string): Promise<PersistedProposal[]>; // run insights / analyses (librarian role; no system code review)
  // applyProposal removed — Brain no longer performs system patching.
  // rejectProposal kept for dismissing an analysis insight.
  rejectProposal(
    proposalId: string,
    reason?: string,
    clonePath?: string,
  ): Promise<{ success: boolean; error?: string }>;
  trackRunHealth(event: { type: string; runId?: string; [key: string]: unknown }): void;
  getHealthSummary(): Map<string, { status: string; errors: number; lastUpdate: number }>;
  getRecentActivities(): BrainActivityEntry[];
  subscribeToEvents(eventHandler: (event: { type: string; [key: string]: unknown }) => void): () => void;
  getBrainHealth(): { status: string; lastAnalysis: number; proposalCount: number; errorCount: number };
  /** Start continuous background monitoring. */
  startBackgroundMonitoring(intervalMs?: number): void;
  stopBackgroundMonitoring(): void;
  /** Prototype: allow Brain to inject a suggestion as system transcript entry for the active run */
  injectSuggestion?(runId: string, suggestion: { title: string; text: string; category?: string }): void;
}

export interface BrainServiceOpts {
  maxConcurrentRuns: number;
  getOrchestrator: () => { start: (cfg: unknown) => Promise<string> };
  getActiveRunCount: () => number;
  canStartRun: () => boolean;
  /** Optional hub or emit for integrating with RunEventHub for organized events */
  emit?: (e: any, category?: string) => void;
  /** For wiring injectSuggestion to actual runner append */
  getRunnerForRun?: (runId: string) => { appendSystemMessage?: (text: string, summary?: any) => void } | null;
}

const MAX_ACTIVITIES = 50;

export function createBrainService(opts: BrainServiceOpts): BrainService {
  const provisioner = createRunProvisioner({
    getOrchestrator: opts.getOrchestrator,
    maxConcurrentRuns: opts.maxConcurrentRuns,
    canStartRun: opts.canStartRun,
    getActiveRunCount: opts.getActiveRunCount,
    onProvision: (runId, proposal) => {
      logActivity({
        type: "provision",
        title: `Brain provisioned run`,
        detail: `${proposal.title} → ${runId ?? "unknown"}`,
        status: "success",
      });
      // Emit to subscribers and hub if provided
      const ev = { type: "brain_provisioned", runId, proposalId: proposal.id ?? null, title: proposal.title };
      eventSubscribers.forEach(fn => { try { fn(ev); } catch {} });
      if (opts.emit) opts.emit(ev, "brain");
    },
    getSystemPressure: () => {
      // Proxy pressure for stability (record load under concurrent/Brain activity)
      return tokenTracker.pressure ? tokenTracker.pressure() : { recordCount: 0, atLimit: false };
    },
  });

  const queue = createBrainQueue();
  const runHealth = new Map<string, { status: string; errors: number; lastUpdate: number; brainInitiated?: boolean }>();
  const eventSubscribers = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const activities: BrainActivityEntry[] = [];
  let brainHealth = { status: "idle", lastAnalysis: 0, proposalCount: 0, errorCount: 0 };
  let lastClonePath: string | undefined;
  let monitoringInterval: NodeJS.Timeout | null = null;

  const logActivity = (entry: Omit<BrainActivityEntry, "timestamp">) => {
    activities.unshift({ ...entry, timestamp: Date.now() });
    if (activities.length > MAX_ACTIVITIES) activities.length = MAX_ACTIVITIES;
  };

  // Iteration on Brain-OS as management layer: lightweight background ticker
  // for real-time health aggregation across concurrent runs.
  const _startBackgroundTicker = (intervalMs = 60000) => {
    if (monitoringInterval) clearInterval(monitoringInterval);
    monitoringInterval = setInterval(() => {
      const pressure = tokenTracker.pressure ? tokenTracker.pressure() : null;
      brainHealth.status = pressure?.atLimit ? "pressure" : "monitoring";

      logActivity({
        type: "health",
        title: "Background health tick",
        detail: `active runs: ${opts.getActiveRunCount()}, pressure: ${pressure ? pressure.recordCount : 'n/a'}`,
        status: "success",
      });

      // Emit for UI / listeners
      eventSubscribers.forEach(fn => {
        try {
          fn({ type: "brain_health_tick", pressure, activeRuns: opts.getActiveRunCount() });
        } catch {}
      });
    }, intervalMs);
  };

  const injectSuggestion = (runId: string, suggestion: { title: string; text: string; category?: string }) => {
    const ev = { type: 'brain_suggestion', runId, ...suggestion };
    eventSubscribers.forEach(fn => { try { fn(ev); } catch {} });
    if (opts.emit) opts.emit(ev, 'brain');

    const summary = { kind: 'brain_suggestion', title: suggestion.title, category: suggestion.category } as any;
    const fullText = `[🧠 Brain Suggestion] ${suggestion.title}\n${suggestion.text}`;

    // Primary: use runner's appendSystemMessage (adds to transcript + emits transcript_append)
    if (opts.getRunnerForRun) {
      const runner = opts.getRunnerForRun(runId);
      if (runner && runner.appendSystemMessage) {
        runner.appendSystemMessage(fullText, summary);
        return;
      }
    }

    // Robust fallback: directly emit a transcript_append so the suggestion appears
    // in the UI transcript even for runner wrappers (e.g. PipelineRunner before support)
    // or other cases where the method isn't exposed on the top-level runner.
    if (opts.emit) {
      const entry = {
        id: (globalThis as any).crypto?.randomUUID?.() || `sug-${Date.now()}`,
        role: "system",
        text: fullText,
        ts: Date.now(),
        summary,
      };
      opts.emit({ type: "transcript_append", entry }, "brain");
    } else {
      console.log('[brain] suggestion for', runId, suggestion.title);
    }
  };

  return {
    async analyzeRun(interactionTracker, exceptionCollector, clonePath, runId, promptFn, model) {
      lastClonePath = clonePath;
      brainHealth.status = "analyzing";
      brainHealth.lastAnalysis = Date.now();
      logActivity({
        type: "analysis",
        title: "Run analysis started",
        detail: `run ${runId.slice(0, 8)}`,
        status: "pending",
      });
      try {
        const result = await runBrainAnalysis(
          interactionTracker,
          exceptionCollector,
          clonePath,
          runId,
          [],
          promptFn,
          model,
        );
        const insightCount = result.insights?.length ?? 0;
        brainHealth.proposalCount += insightCount;
        brainHealth.status = "idle";
        logActivity({
          type: "analysis",
          title: "Run analysis complete",
          detail: `${insightCount} insights, ${result.exceptions.totalExceptions} exceptions`,
          status: "success",
        });
        for (const p of result.insights || []) {
          logActivity({
            type: "proposal", // keeping type for UI compat; represents "insight"
            title: p.title,
            detail: `${p.category || p.priority}`,
            status: "pending",
          });
        }
        return result;
      } catch (err) {
        brainHealth.errorCount++;
        brainHealth.status = "error";
        const msg = err instanceof Error ? err.message : String(err);
        logActivity({
          type: "error",
          title: "Run analysis failed",
          detail: msg,
          status: "failed",
        });
        throw err;
      }
    },

    getProvisioner() { return provisioner; },
    getQueue() { return queue; },
    getClonePath() { return lastClonePath; },

    registerClonePath(clonePath) {
      lastClonePath = clonePath;
    },

    async getAllProposals(clonePath) {
      const path = clonePath ?? lastClonePath;
      if (!path) return [];
      const proposals = await readProposals(path);
      return proposals.filter((p) => p.status === "pending");
    },

    // applyProposal (system patching) has been removed.
    // Brain now focuses on run analysis insights only.

    async rejectProposal(proposalId, reason, clonePath) {
      const path = clonePath ?? lastClonePath;
      if (!path) {
        return { success: false, error: "No clone path configured" };
      }

      await updateProposalStatus(path, proposalId, "rejected", reason);
      logActivity({
        type: "proposal",
        title: `Dismissed insight ${proposalId}`,
        detail: reason || "",
        status: "failed",
      });
      return { success: true };
    },

    trackRunHealth(event: any) {
      const runId = event.runId;
      if (!runId) return;
      const current = runHealth.get(runId) ?? { status: "unknown", errors: 0, lastUpdate: 0 };
      if (event.type === "swarm_state") current.status = event.phase ?? current.status;
      else if (event.type === "error") {
        current.errors += 1;
        const errMsg = typeof event.message === "string" ? event.message : runId.slice(0, 8);
        logActivity({ type: "error", title: "Run error", detail: errMsg, status: "failed" });
      }
      if (event.brainInitiated) current.brainInitiated = true;
      current.lastUpdate = Date.now();
      runHealth.set(runId, current);
      for (const subscriber of eventSubscribers) {
        try { subscriber(event); } catch {}
      }
    },

    getHealthSummary() { return new Map(runHealth); },
    getRecentActivities() { return [...activities]; },

    subscribeToEvents(eventHandler) {
      eventSubscribers.add(eventHandler);
      return () => { eventSubscribers.delete(eventHandler); };
    },

    getBrainHealth() { 
      return { 
        ...brainHealth,
        activeRunHealth: Object.fromEntries(runHealth),
        pressure: { 
          trackedRuns: runHealth.size 
        }
      }; 
    },

    startBackgroundMonitoring(intervalMs = 60000) {
      _startBackgroundTicker(intervalMs);
    },

    stopBackgroundMonitoring() {
      if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
      }
    },

    injectSuggestion,
  };
}

// Re-export for tests that seed proposals directly.
export { appendProposal };