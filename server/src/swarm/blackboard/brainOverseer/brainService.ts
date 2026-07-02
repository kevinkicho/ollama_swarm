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
import { createSelfUpgrader, type UpgradeResult } from "./selfUpgrader.js";
import { tokenTracker } from "../../../services/ollamaProxy.js";

export interface BrainActivityEntry {
  timestamp: number;
  type: "analysis" | "proposal" | "patch" | "health" | "error" | "provision";
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
  getAllProposals(clonePath?: string): Promise<PersistedProposal[]>;
  applyProposal(
    proposalId: string,
    patchContent: { file: string; search: string; replace: string }[],
    clonePath?: string,
  ): Promise<UpgradeResult>;
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
}

export interface BrainServiceOpts {
  maxConcurrentRuns: number;
  getOrchestrator: () => { start: (cfg: unknown) => Promise<string> };
  getActiveRunCount: () => number;
  canStartRun: () => boolean;
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
      // Emit to subscribers so UI / listeners get brain-provisioned-run event
      const ev = { type: "brain_provisioned", runId, proposalId: proposal.id ?? null, title: proposal.title };
      eventSubscribers.forEach(fn => { try { fn(ev); } catch {} });
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

  const logActivity = (entry: Omit<BrainActivityEntry, "timestamp">) => {
    activities.unshift({ ...entry, timestamp: Date.now() });
    if (activities.length > MAX_ACTIVITIES) activities.length = MAX_ACTIVITIES;
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
        brainHealth.proposalCount += result.proposals.length;
        brainHealth.status = "idle";
        logActivity({
          type: "analysis",
          title: "Run analysis complete",
          detail: `${result.proposals.length} proposals, ${result.exceptions.totalExceptions} exceptions`,
          status: "success",
        });
        for (const p of result.proposals) {
          logActivity({
            type: "proposal",
            title: p.title,
            detail: `${p.priority} · ${p.affectedComponent}`,
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

    async applyProposal(proposalId, patchContent, clonePath) {
      const path = clonePath ?? lastClonePath;
      if (!path) {
        return { success: false, patchesApplied: 0, error: "No clone path configured" };
      }

      const proposals = await readProposals(path);
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal) {
        return { success: false, patchesApplied: 0, error: "Proposal not found" };
      }
      if (proposal.status !== "pending") {
        return { success: false, patchesApplied: 0, error: `Proposal already ${proposal.status}` };
      }

      // Polish UX: if caller didn't provide patches, fall back to suggestedHunks from proposal
      const effectiveHunks = patchContent.length > 0 
        ? patchContent 
        : (proposal.suggestedHunks || []).map(h => ({ file: h.file, search: h.search, replace: h.replace }));

      const upgrader = createSelfUpgrader({
        getActiveRunCount: opts.getActiveRunCount,
        clonePath: path,
        autoCommit: true,
      });

      if (!upgrader.canApplyPatches()) {
        return {
          success: false,
          patchesApplied: 0,
          error: "Cannot apply patches while runs are active",
        };
      }

      const result = await upgrader.applyPatch(proposal, effectiveHunks);
      if (result.success) {
        await updateProposalStatus(path, proposalId, "applied");
        logActivity({
          type: "patch",
          title: `Applied: ${proposal.title}`,
          detail: `${result.patchesApplied} patch(es)${result.commitSha ? ` (commit ${result.commitSha.slice(0,7)})` : ''}`,
          status: "success",
        });
      } else {
        logActivity({
          type: "patch",
          title: `Apply failed: ${proposal.title}`,
          detail: result.error,
          status: "failed",
        });
      }
      return result;
    },

    async rejectProposal(proposalId, reason, clonePath) {
      const path = clonePath ?? lastClonePath;
      if (!path) {
        return { success: false, error: "No clone path configured" };
      }

      const proposals = await readProposals(path);
      const proposal = proposals.find((p) => p.id === proposalId);
      if (!proposal) {
        return { success: false, error: "Proposal not found" };
      }
      if (proposal.status !== "pending") {
        return { success: false, error: `Proposal already ${proposal.status}` };
      }

      await updateProposalStatus(path, proposalId, "rejected", reason);
      logActivity({
        type: "proposal",
        title: `Rejected: ${proposal.title}`,
        detail: reason,
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
          // lightweight system pressure
          trackedRuns: runHealth.size 
        }
      }; 
    },
  };
}

// Re-export for tests that seed proposals directly.
export { appendProposal };